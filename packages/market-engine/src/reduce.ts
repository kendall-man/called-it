/**
 * The settlement state machine. Pure: (state, event) → (state', effects).
 * Time only ever flows in via event timestamps or the explicit `nowMs`
 * parameter of checkDebounce — never Date.now().
 *
 * Core rules (PRD "the hard 20%"):
 * - Freezes: var_check / possible_event / unconfirmed goals / odds suspension
 *   lock calls immediately; minute-85 cutoff and kickoff (player markets) lock
 *   them permanently until settlement.
 * - Settlement candidates enter a debounce window. They settle when a later
 *   event arrives OR the debounce elapses — whichever is first. Reversals
 *   (goal_discarded / goal_amended) and fresh VAR flags inside the window
 *   cancel the candidate instead.
 * - Terminal phases settle whole-match claims with FT vs FT_90 semantics; if
 *   the outcome is not derivable at a terminal phase (e.g. level after pens
 *   for an advancing claim) the market voids honestly.
 * - VOID_PHASES and coverage warnings void the market (engine refunds).
 * - Own goals count for team tallies (they are in the feed score) but never
 *   credit a player claim.
 * - Delay-snipe guard: pending taps placed after an event's on-pitch timestamp
 *   are voided; pending taps whose window has elapsed activate.
 */
import {
  TERMINAL_PHASES,
  VOID_PHASES,
  type GamePhase,
  type MarketEffect,
  type MarketSpec,
  type MarketState,
  type MatchEvent,
  type Position,
  type ReduceResult,
  type SettlementOutcome,
} from './types.js';
import { PENDING_TAP_WINDOW_MS, TUNABLES } from './constants.js';
import { evaluateSpec } from './evaluate.js';

// ── Reducer-private state carried across events ───────────────────────────

type FreezeReason = 'var' | 'possible_event' | 'odds_suspension' | 'cutoff';

/** A confirmed goal currently standing (discards remove, amends re-attribute). */
interface StandingGoal {
  seq: number;
  participant: 1 | 2 | null;
  playerNormativeId: number | null;
  ownGoal: boolean;
  phase: GamePhase;
}

/**
 * Cross-event bookkeeping the shared MarketState type does not model.
 * Persisted alongside the state by the engine (it round-trips through JSON);
 * rebuilt from defaults when absent.
 */
export interface ReducerScratch {
  /** Last processed seq — duplicate-delivery guard. Starts at the comeback anchor. */
  lastSeq: number;
  goals: StandingGoal[];
  freezeReason: FreezeReason | null;
  /** Once true the market can never unfreeze back to open (85' / kickoff lock). */
  cutoffReached: boolean;
}

/** MarketState plus the reducer's scratch — what reduceMarket actually returns. */
export interface ReducibleMarketState extends MarketState {
  scratch?: ReducerScratch;
}

const VOID_REASON_BY_PHASE: Partial<Record<GamePhase, string>> = {
  ABD: 'match abandoned — all Rep goes back',
  CAN: 'match cancelled — all Rep goes back',
  POST: 'match postponed — all Rep goes back',
  COV_LOST: 'coverage lost — no fair market without the feed, all Rep goes back',
};
const COVERAGE_VOID_REASON =
  'coverage went unreliable — no fair market without the feed, all Rep goes back';
const LINEUP_DNP_VOID_REASON =
  'left out of the lineup — all Rep goes back';
const UNDECIDABLE_VOID_REASON =
  'final data cannot decide this one — all Rep goes back';

const INPLAY_PHASES: readonly GamePhase[] = [
  'H1',
  'HT',
  'H2',
  'F',
  'ET1',
  'HTET',
  'ET2',
  'PE',
  'FET',
  'FPE',
  'INT',
];
/** Phases in which new Rep can never enter (staking permanently closed). */
const LATE_CUTOFF_PHASES: readonly GamePhase[] = [
  'ET1',
  'HTET',
  'ET2',
  'PE',
  'F',
  'FET',
  'FPE',
];

// ── Scratch helpers ───────────────────────────────────────────────────────

function initialScratch(spec: MarketSpec): ReducerScratch {
  return {
    lastSeq: spec.anchor?.seq ?? 0,
    goals: [],
    freezeReason: null,
    cutoffReached: false,
  };
}

function cloneScratch(scratch: ReducerScratch): ReducerScratch {
  return {
    lastSeq: scratch.lastSeq,
    goals: scratch.goals.map((g) => ({ ...g })),
    freezeReason: scratch.freezeReason,
    cutoffReached: scratch.cutoffReached,
  };
}

function scratchOf(state: MarketState): ReducerScratch {
  const existing = (state as ReducibleMarketState).scratch;
  return existing ? cloneScratch(existing) : initialScratch(state.spec);
}

function teamParticipant(spec: MarketSpec): 1 | 2 | null {
  return spec.entityRef.participant;
}

/** Standing goals credited to the spec's player under its period semantics. */
function playerGoalCount(scratch: ReducerScratch, spec: MarketSpec): number {
  if (spec.entityRef.kind !== 'player') return 0;
  const playerId = spec.entityRef.normativeId;
  return scratch.goals.filter((g) => {
    if (g.playerNormativeId !== playerId || g.ownGoal) return false;
    if (g.phase === 'PE') return false; // shootout kicks are never player goals
    if (spec.period === 'FT_90') {
      return g.phase === 'H1' || g.phase === 'HT' || g.phase === 'H2';
    }
    return true;
  }).length;
}

/** Seqs of standing goals relevant to this spec, plus the deciding seq. */
function buildEvidence(
  scratch: ReducerScratch,
  spec: MarketSpec,
  decidingSeq: number,
): number[] {
  let relevant: StandingGoal[];
  switch (spec.claimType) {
    case 'team_scores_n': {
      const participant = teamParticipant(spec);
      relevant = scratch.goals.filter((g) => g.participant === participant);
      break;
    }
    case 'player_scores_n': {
      const id =
        spec.entityRef.kind === 'player' ? spec.entityRef.normativeId : null;
      relevant = scratch.goals.filter(
        (g) => g.playerNormativeId === id && !g.ownGoal,
      );
      break;
    }
    default:
      relevant = scratch.goals;
  }
  const seqs = new Set<number>(relevant.map((g) => g.seq));
  seqs.add(decidingSeq);
  return [...seqs].sort((a, b) => a - b);
}

// ── Small predicates ──────────────────────────────────────────────────────

function isReversal(event: MatchEvent): boolean {
  return event.kind === 'goal_discarded' || event.kind === 'goal_amended';
}

function isHoldSignal(event: MatchEvent): boolean {
  return (
    event.kind === 'var_check' ||
    event.kind === 'possible_event' ||
    (event.kind === 'goal' && !event.confirmed) ||
    (event.kind === 'odds_suspension' && event.confirmed)
  );
}

function holdReasonFor(event: MatchEvent): FreezeReason {
  if (event.kind === 'var_check') return 'var';
  if (event.kind === 'odds_suspension') return 'odds_suspension';
  return 'possible_event';
}

/** Goals and red cards are the price-moving moments TV viewers can snipe. */
function isPriceMoving(event: MatchEvent): boolean {
  if (!event.confirmed) return false;
  if (event.kind === 'goal') return true;
  return event.kind === 'card' && event.detail?.card === 'red';
}

function cutoffTriggered(spec: MarketSpec, event: MatchEvent): boolean {
  if (
    event.minute !== null &&
    event.minute >= TUNABLES.INPLAY_STAKE_CUTOFF_MINUTE
  ) {
    return true;
  }
  if (LATE_CUTOFF_PHASES.includes(event.phase)) return true;
  // Player markets close for staking at kickoff (pre-match-only type).
  return (
    spec.claimType === 'player_scores_n' && INPLAY_PHASES.includes(event.phase)
  );
}

// ── Position lifecycle within an event ────────────────────────────────────

function applyPositionGuards(
  positions: Position[],
  event: MatchEvent,
  effects: MarketEffect[],
): Position[] {
  const next = positions.map((p) => ({ ...p }));
  if (isPriceMoving(event)) {
    const sniped = next.filter(
      (p) => p.state === 'pending' && p.placedAtMs > event.tsMs,
    );
    if (sniped.length > 0) {
      for (const p of sniped) p.state = 'void';
      effects.push({
        kind: 'void_positions',
        positionIds: sniped.map((p) => p.id),
        reason: 'delay_snipe',
      });
    }
  }
  const matured = next.filter(
    (p) =>
      p.state === 'pending' &&
      event.receivedAtMs >= p.placedAtMs + PENDING_TAP_WINDOW_MS,
  );
  if (matured.length > 0) {
    for (const p of matured) p.state = 'active';
    effects.push({
      kind: 'activate_positions',
      positionIds: matured.map((p) => p.id),
    });
  }
  return next;
}

/** Remaining pending taps at settlement beat every deciding moment — activate. */
function activateRemainingPending(
  positions: Position[],
  effects: MarketEffect[],
): Position[] {
  const next = positions.map((p) => ({ ...p }));
  const pending = next.filter((p) => p.state === 'pending');
  if (pending.length > 0) {
    for (const p of pending) p.state = 'active';
    effects.push({
      kind: 'activate_positions',
      positionIds: pending.map((p) => p.id),
    });
  }
  return next;
}

// ── Settlement helpers ────────────────────────────────────────────────────

function settleNow(
  state: ReducibleMarketState,
  effects: MarketEffect[],
): ReducibleMarketState {
  const pending = state.pendingSettlement;
  if (!pending) return state;
  const positions = activateRemainingPending(state.positions, effects);
  effects.push({
    kind: 'settle',
    outcome: pending.outcome,
    decidingSeq: pending.decidingSeq,
    evidenceSeqs: pending.evidenceSeqs,
  });
  return {
    ...state,
    positions,
    status: 'settled',
    pendingSettlement: null,
  };
}

function voidMarket(
  state: ReducibleMarketState,
  reason: string,
  effects: MarketEffect[],
): ReducibleMarketState {
  effects.push({ kind: 'void', reason });
  return { ...state, status: 'voided', pendingSettlement: null };
}

// ── Goal bookkeeping ──────────────────────────────────────────────────────

function trackGoals(scratch: ReducerScratch, event: MatchEvent): void {
  if (event.kind === 'goal' && event.confirmed) {
    scratch.goals.push({
      seq: event.seq,
      participant: event.detail?.participant ?? null,
      playerNormativeId: event.detail?.playerNormativeId ?? null,
      ownGoal: event.detail?.goalType === 'own_goal',
      phase: event.phase,
    });
    return;
  }
  const reversesSeq = event.detail?.reversesSeq;
  if (reversesSeq === undefined) return;
  if (event.kind === 'goal_discarded') {
    scratch.goals = scratch.goals.filter((g) => g.seq !== reversesSeq);
    return;
  }
  if (event.kind === 'goal_amended') {
    const goal = scratch.goals.find((g) => g.seq === reversesSeq);
    if (goal) {
      if (event.detail?.participant !== undefined) {
        goal.participant = event.detail.participant;
      }
      if (event.detail?.playerNormativeId !== undefined) {
        goal.playerNormativeId = event.detail.playerNormativeId;
      }
      goal.ownGoal = event.detail?.goalType === 'own_goal';
    }
  }
}

// ── pending_lineup handling ───────────────────────────────────────────────

function reducePendingLineup(
  state: ReducibleMarketState,
  event: MatchEvent,
  scratch: ReducerScratch,
): ReduceResult {
  const effects: MarketEffect[] = [];
  let next: ReducibleMarketState = { ...state, scratch };

  if (VOID_PHASES.includes(event.phase) || event.kind === 'coverage_warning') {
    const reason =
      VOID_REASON_BY_PHASE[event.phase] ?? COVERAGE_VOID_REASON;
    return { state: voidMarket(next, reason, effects), effects };
  }

  const spec = state.spec;
  if (
    event.kind === 'lineup' &&
    spec.entityRef.kind === 'player' &&
    event.detail?.playerNormativeId === spec.entityRef.normativeId
  ) {
    // Bind the side now that the lineup names it (types.ts: "bound at lineup time").
    const boundEntity =
      event.detail.participant !== undefined
        ? { ...spec.entityRef, participant: event.detail.participant }
        : spec.entityRef;
    next = {
      ...next,
      spec: { ...spec, entityRef: boundEntity },
      status: 'open',
    };
    effects.push({ kind: 'activate_market' });
    next = {
      ...next,
      positions: activateRemainingPending(next.positions, effects),
    };
    return { state: next, effects };
  }

  if (INPLAY_PHASES.includes(event.phase)) {
    // Kickoff arrived and the lineup never named them — DNP void.
    return {
      state: voidMarket(next, LINEUP_DNP_VOID_REASON, effects),
      effects,
    };
  }
  return { state: next, effects };
}

// ── The reducer ───────────────────────────────────────────────────────────

export function reduceMarket(
  state: MarketState,
  event: MatchEvent,
): ReduceResult {
  if (state.status === 'settled' || state.status === 'voided') {
    return { state, effects: [] };
  }
  if (event.fixtureId !== state.spec.fixtureId) {
    return { state, effects: [] };
  }
  const scratch = scratchOf(state);
  if (event.seq <= scratch.lastSeq) {
    // Duplicate or stale delivery — settlement must be idempotent.
    return { state, effects: [] };
  }
  scratch.lastSeq = event.seq;

  if (state.status === 'pending_lineup') {
    return reducePendingLineup(state as ReducibleMarketState, event, scratch);
  }

  const effects: MarketEffect[] = [];
  const spec = state.spec;
  let next: ReducibleMarketState = {
    ...state,
    scratch,
    positions: state.positions,
    pendingSettlement: state.pendingSettlement
      ? { ...state.pendingSettlement }
      : null,
  };

  // 1. Fixture-fatal states void everything immediately.
  if (VOID_PHASES.includes(event.phase) || event.kind === 'coverage_warning') {
    const reason = VOID_REASON_BY_PHASE[event.phase] ?? COVERAGE_VOID_REASON;
    return { state: voidMarket(next, reason, effects), effects };
  }

  // 2. Goal ledger (standing goals feed player tallies and evidence lists).
  trackGoals(scratch, event);

  // 3. Position fairness guards (snipe voids before window activations).
  next = { ...next, positions: applyPositionGuards(next.positions, event, effects) };

  // 4. Staking cutoffs are permanent.
  if (cutoffTriggered(spec, event) && !scratch.cutoffReached) {
    scratch.cutoffReached = true;
    if (next.status === 'open') {
      scratch.freezeReason = 'cutoff';
      next = { ...next, status: 'frozen' };
      effects.push({ kind: 'freeze', reason: 'cutoff' });
    }
  }

  // 5. Debounced-settlement interaction with this (strictly later) event.
  if (next.pendingSettlement) {
    if (isHoldSignal(event)) {
      // Fresh doubt inside the window: cancel the candidate and lock calls.
      next = { ...next, pendingSettlement: null, status: 'frozen' };
      scratch.freezeReason = holdReasonFor(event);
      effects.push({ kind: 'freeze', reason: scratch.freezeReason });
      return { state: next, effects };
    }
    if (isReversal(event)) {
      // Evidence changed under the candidate: drop it and re-evaluate below
      // against the event's authoritative score.
      next = {
        ...next,
        pendingSettlement: null,
        status: scratch.cutoffReached ? 'frozen' : 'open',
      };
      scratch.freezeReason = scratch.cutoffReached ? 'cutoff' : null;
    } else {
      // Any other later event confirms the candidate — settle now.
      next = settleNow(next, effects);
      return { state: next, effects };
    }
  }

  // 6. Freeze / unfreeze signals. The freeze reason doubles as the "doubt"
  //    marker: while a var/possible_event doubt is live, settlement waits.
  if (isHoldSignal(event)) {
    const reason = holdReasonFor(event);
    scratch.freezeReason = reason;
    if (next.status === 'open') {
      next = { ...next, status: 'frozen' };
      effects.push({ kind: 'freeze', reason });
    }
    return { state: next, effects };
  }
  const doubtActive =
    scratch.freezeReason === 'var' || scratch.freezeReason === 'possible_event';
  const varResolved = event.kind === 'var_end' && doubtActive;
  // A possible-event doubt is answered by whatever confirmed event follows it
  // (the possibility either materialized or evaporated).
  const possibleResolved =
    scratch.freezeReason === 'possible_event' && event.confirmed;
  // A discard/amend IS the VAR verdict — no separate var_end required.
  const reversalResolved = doubtActive && isReversal(event);
  const suspensionLifted =
    event.kind === 'odds_suspension' &&
    !event.confirmed &&
    scratch.freezeReason === 'odds_suspension';
  if (varResolved || possibleResolved || reversalResolved || suspensionLifted) {
    if (scratch.cutoffReached) {
      scratch.freezeReason = 'cutoff';
    } else {
      scratch.freezeReason = null;
      if (next.status === 'frozen') {
        next = { ...next, status: 'open' };
        effects.push({ kind: 'unfreeze' });
      }
    }
  }

  // 7. Settlement evaluation — only confirmed events, never under an open
  //    VAR/possible-event doubt.
  const underDoubt =
    scratch.freezeReason === 'var' || scratch.freezeReason === 'possible_event';
  if (event.confirmed && !underDoubt) {
    const playerGoals =
      spec.claimType === 'player_scores_n'
        ? playerGoalCount(scratch, spec)
        : undefined;
    const outcome = evaluateSpec(spec, event.score, event.phase, playerGoals);
    if (outcome === 'void') {
      return { state: voidMarket(next, UNDECIDABLE_VOID_REASON, effects), effects };
    }
    if (outcome !== null) {
      next = {
        ...next,
        status: 'settling',
        pendingSettlement: {
          outcome,
          decidingSeq: event.seq,
          evidenceSeqs: buildEvidence(scratch, spec, event.seq),
          debounceUntilMs:
            event.receivedAtMs + TUNABLES.SETTLEMENT_DEBOUNCE_MS,
        },
      };
      return { state: next, effects };
    }
    if (TERMINAL_PHASES.includes(event.phase)) {
      // Terminal and still undecidable (e.g. advancing claim level after
      // pens, or FT_90 in ET without a 90' split) — void honestly.
      return {
        state: voidMarket(next, UNDECIDABLE_VOID_REASON, effects),
        effects,
      };
    }
  }

  // 8. Live price hint for still-open markets on meaningful moments.
  if (next.status === 'open' && isPriceMoving(event)) {
    effects.push({ kind: 'reprice_hint' });
  }

  return { state: next, effects };
}

// ── Debounce tick ─────────────────────────────────────────────────────────

/**
 * Settles a pending settlement whose debounce window has elapsed, and matures
 * pending taps whose anti-snipe window has passed. Driven by the engine's
 * clock tick; `nowMs` is the only time source.
 */
export function checkDebounce(state: MarketState, nowMs: number): ReduceResult {
  if (state.status === 'settled' || state.status === 'voided') {
    return { state, effects: [] };
  }
  const effects: MarketEffect[] = [];
  let next: ReducibleMarketState = { ...(state as ReducibleMarketState) };

  const matured = next.positions.filter(
    (p) =>
      p.state === 'pending' && nowMs >= p.placedAtMs + PENDING_TAP_WINDOW_MS,
  );
  if (matured.length > 0) {
    const positions = next.positions.map((p) =>
      matured.some((m) => m.id === p.id) ? { ...p, state: 'active' as const } : p,
    );
    next = { ...next, positions };
    effects.push({
      kind: 'activate_positions',
      positionIds: matured.map((p) => p.id),
    });
  }

  if (next.pendingSettlement && nowMs >= next.pendingSettlement.debounceUntilMs) {
    next = settleNow(next, effects);
  }

  if (effects.length === 0) {
    return { state, effects };
  }
  return { state: next, effects };
}
