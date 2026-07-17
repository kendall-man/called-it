/**
 * In-process UI state for the two-step stake ladder (STAKE_LADDER_ENABLED).
 *
 * The whole life of a claim is one evolving card message; while a member is
 * composing a stake the card shows a value ladder (or a sign handoff) instead
 * of the two-side offer. That transient visual is the ONLY thing kept here,
 * keyed by marketId and shared across the group (any member's rung tap is
 * honored). It is deliberately NOT durable: a restart loses only the visual —
 * no SOL, no session, no position depends on it. All money safety lives in the
 * escrow session, the wager RPC, and the reducer, none of which read this store.
 *
 * Two safety nets keep the shared surface from getting stuck on someone's
 * half-composed ladder: an auto-revert timer (onExpire re-renders the offer)
 * and a lazy revert (an expired `get` clears and returns null so the next tap
 * re-renders the offer). Clock and scheduler are injectable for tests.
 */

/** Value-ladder step: a side is picked, awaiting a rung. */
export interface LadderUiState {
  readonly kind: 'ladder';
  readonly side: 'back' | 'doubt';
}

/** Sign handoff (escrow): a rung is picked, awaiting the Mini App signature. */
export interface SignUiState {
  readonly kind: 'sign';
  readonly side: 'back' | 'doubt';
  readonly amountCode: 1 | 2 | 5 | 10;
}

export type StakeUiState = LadderUiState | SignUiState;

/** Auto-revert budgets: composing a value, and reviewing a sign handoff. */
export const STAKE_LADDER_TTL_MS = 20_000;
export const STAKE_SIGN_TTL_MS = 30_000;

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
