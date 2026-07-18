/**
 * In-process UI state for the n-step stake stepper (STAKE_LADDER_ENABLED).
 *
 * The whole life of a claim is one evolving card message; while a member is
 * composing a stake the card shows a small editable stepper (−/amount/+, plus a
 * sign-or-confirm action) instead of the two-side offer. That transient visual
 * is the ONLY thing kept here, keyed by marketId and shared across the group
 * (any member's ± tap is honored). It is deliberately NOT durable: a restart
 * loses only the visual — no SOL, no session, no position depends on it. All
 * money safety lives in the escrow session, the wager RPC, and the reducer,
 * none of which read this store.
 *
 * `code` is the CURRENT rung (base units of 0.01 of the asset); a ± tap sets it
 * and re-renders, and the explicit sign/confirm reads it. Entry is always the
 * anchor rung (code 1 = 0.01), never a higher preselection.
 *
 * Two safety nets keep the shared surface from getting stuck on someone's
 * half-composed stepper: an auto-revert timer (onExpire re-renders the offer)
 * and a lazy revert (an expired `get` clears and returns null so the next tap
 * re-renders the offer). Clock and scheduler are injectable for tests.
 */

/** Stepper step: a side is picked and a rung (`code`) is dialed but not committed. */
export interface LadderUiState {
  readonly kind: 'ladder';
  readonly side: 'back' | 'doubt';
  /** The current rung, in base units of 0.01 of the asset. */
  readonly code: 1 | 2 | 5 | 10;
}

export type StakeUiState = LadderUiState;

/** Auto-revert budget for a half-composed stepper (a purely visual timeout). */
export const STAKE_LADDER_TTL_MS = 20_000;

export interface UiStateStoreOptions {
  now?: () => number;
  /** Defers the auto-revert; tests inject a manual scheduler. */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** Fires when a state's TTL elapses without being replaced (auto-revert). */
  onExpire?: (marketId: string, state: StakeUiState) => void;
}

interface Entry {
  state: StakeUiState;
  expiresAtMs: number;
  epoch: number;
  cancel: () => void;
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  // Never keep the process alive for a purely visual revert.
  timer.unref?.();
  return () => clearTimeout(timer);
}

export class UiStateStore {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly onExpire: (marketId: string, state: StakeUiState) => void;
  private epoch = 0;

  constructor(options: UiStateStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? defaultSchedule;
    this.onExpire = options.onExpire ?? (() => undefined);
  }

  /** Replace any current state for this market and arm a fresh auto-revert. */
  set(marketId: string, state: StakeUiState, ttlMs: number): void {
    this.clear(marketId);
    const epoch = (this.epoch += 1);
    const expiresAtMs = this.now() + ttlMs;
    const cancel = this.schedule(() => {
      const entry = this.entries.get(marketId);
      // Only fire for the exact state this timer was armed for — a later tap
      // that replaced or cleared it must not trigger a stale revert.
      if (entry !== undefined && entry.epoch === epoch) {
        this.entries.delete(marketId);
        this.onExpire(marketId, entry.state);
      }
    }, ttlMs);
    this.entries.set(marketId, { state, expiresAtMs, epoch, cancel });
  }

  /**
   * The current state, or null when absent or expired. An expired read clears
   * the entry (lazy revert) so a later tap re-renders the offer even if the
   * scheduler never ran.
   */
  get(marketId: string, nowMs: number = this.now()): StakeUiState | null {
    const entry = this.entries.get(marketId);
    if (entry === undefined) return null;
    if (entry.expiresAtMs <= nowMs) {
      this.clear(marketId);
      return null;
    }
    return entry.state;
  }

  clear(marketId: string): void {
    const entry = this.entries.get(marketId);
    if (entry === undefined) return;
    entry.cancel();
    this.entries.delete(marketId);
  }

  /** Cancel every pending revert (shutdown). */
  stop(): void {
    for (const entry of this.entries.values()) entry.cancel();
    this.entries.clear();
  }
}
