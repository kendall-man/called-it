/**
 * Core domain contract for Called It.
 *
 * This file is the coordination point for the whole monorepo: packages/txline
 * normalizes raw TxLINE payloads INTO these types, packages/agent produces
 * candidate MarketSpecs validated against them, and apps/engine wires the two
 * through the pure functions exported by this package. Nothing in this package
 * may perform I/O.
 */

// ── Claims & markets ──────────────────────────────────────────────────────

export const CLAIM_TYPES = [
  'match_winner',
  'totals_ou',
  'team_scores_n',
  'btts',
  'player_scores_n',
  'comeback',
] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

/** FT includes extra time / penalties where the fixture goes there; FT_90 is regulation only. */
export type Period = 'FT' | 'FT_90';

export type TeamRef = { kind: 'team'; participant: 1 | 2; name: string };
export type PlayerRef = {
  kind: 'player';
  normativeId: number;
  name: string;
  /** Which side the player belongs to; bound at lineup time. */
  participant: 1 | 2 | null;
};
export type EntityRef = TeamRef | PlayerRef;

export type Comparator = 'gte' | 'lte' | 'eq';

/** Snapshot of match state at claim time; REQUIRED for 'comeback'. */
export type ClaimAnchor = { seq: number; scoreP1: number; scoreP2: number };

export type TrustTier = 'chain_proven' | 'oracle_resolved';

export interface MarketSpec {
  claimType: ClaimType;
  fixtureId: number;
  entityRef: EntityRef;
  comparator: Comparator;
  threshold: number;
  period: Period;
  anchor?: ClaimAnchor;
  /** Derived by the compiler from claimType — never chosen by the LLM. */
  trustTier: TrustTier;
}

export type MarketStatus =
  | 'pending_lineup'
  | 'open'
  | 'frozen'
  | 'settling'
  | 'settled'
  | 'voided';

export type PositionSide = 'back' | 'doubt';

export interface Position {
  id: string;
  userId: string;
  side: PositionSide;
  stake: number;
  lockedMultiplier: number;
  /** Wall-clock ms when the tap landed — drives the delay-arbitrage guard. */
  placedAtMs: number;
  /** 'pending' until the anti-snipe window clears; 'void' if sniped. */
  state: 'pending' | 'active' | 'void';
}

// ── Normalized feed events (produced by packages/txline) ─────────────────

export type GamePhase =
  | 'NS' | 'H1' | 'HT' | 'H2' | 'F'
  | 'ET1' | 'HTET' | 'ET2' | 'FET'
  | 'PE' | 'FPE'
  | 'INT' | 'ABD' | 'CAN' | 'POST' | 'COV_LOST';

export const TERMINAL_PHASES: readonly GamePhase[] = ['F', 'FET', 'FPE'];
export const VOID_PHASES: readonly GamePhase[] = ['ABD', 'CAN', 'POST', 'COV_LOST'];

/** Team-level running tallies (mirrors on-chain stat keys 1–8). */
export interface TeamStats {
  goals: number;
  yellowCards: number;
  redCards: number;
  corners: number;
}

export interface ScoreState {
  p1: TeamStats;
  p2: TeamStats;
  /** Regulation-only goals, needed for FT_90 settlement when a match goes to ET. */
  p1Goals90: number | null;
  p2Goals90: number | null;
}

export type MatchEventKind =
  | 'goal'
  | 'goal_amended'
  | 'goal_discarded'
  | 'card'
  | 'var_check'
  | 'var_end'
  | 'phase_change'
  | 'lineup'
  | 'possible_event'
  | 'odds_suspension'
  | 'coverage_warning'
  | 'stat_update'
  | 'other';

export interface MatchEvent {
  kind: MatchEventKind;
  fixtureId: number;
  /** Per-fixture sequence number — the settlement ordering key. */
  seq: number;
  /** Event timestamp from the feed (ms). On the delayed tier this precedes receipt. */
  tsMs: number;
  /** Wall-clock ms when WE received it — tsMs↔receivedAtMs gap is the measured delay. */
  receivedAtMs: number;
  confirmed: boolean;
  phase: GamePhase;
  minute: number | null;
  score: ScoreState;
  detail?: {
    participant?: 1 | 2;
    playerNormativeId?: number | null;
    playerName?: string | null;
    goalType?: 'head' | 'shot' | 'own_goal' | 'penalty' | 'other';
    card?: 'yellow' | 'red';
    /** For amend/discard: the seq of the event being reversed. */
    reversesSeq?: number;
  };
}

// ── Pricing ───────────────────────────────────────────────────────────────

export type PriceProvenance = 'market' | 'modelled';

export interface OddsInputs {
  /** Demargined probabilities for home/draw/away (1X2, 90-minute market). */
  p1x2: { home: number; draw: number; away: number } | null;
  /** Total-goals line and its over probability, demargined. */
  totals: { line: number; overProb: number } | null;
  /** Provenance pin for later /api/odds/validation proof. */
  oddsMessageId: string | null;
  oddsTsMs: number | null;
}

export interface PriceQuote {
  probability: number;
  /** Rep multiplier = clamp(1/p). Render as "×N Rep", never odds notation. */
  multiplier: number;
  provenance: PriceProvenance;
  oddsMessageId: string | null;
  oddsTsMs: number | null;
}

// ── Compiler ──────────────────────────────────────────────────────────────

/** What the LLM proposes; the compiler alone decides what becomes a MarketSpec. */
export interface RawClaimParse {
  claimType: ClaimType | null;
  fixtureId: number | null;
  entityName: string | null;
  entityKind: 'team' | 'player' | null;
  comparator: Comparator | null;
  threshold: number | null;
  period: Period | null;
  /** Free-text the model could not structure; compiler treats as unresolvable. */
  unresolved: string | null;
}

export interface CompileContext {
  fixture: {
    fixtureId: number;
    p1Name: string;
    p2Name: string;
    kickoffMs: number;
    phase: GamePhase;
    minute: number | null;
    score: { p1Goals: number; p2Goals: number };
    lastSeq: number;
    coverageUnreliable: boolean;
  } | null;
  knownPlayers: Array<{ normativeId: number; name: string; participant: 1 | 2 | null }>;
  nowMs: number;
}

export type CompileResult =
  | { kind: 'ok'; spec: MarketSpec }
  | { kind: 'clarify'; question: string; options: Array<{ label: string; spec: MarketSpec }> }
  | {
      kind: 'counter_offer';
      reason: string;
      asStated: MarketSpec | null;
      upgrade: MarketSpec;
    }
  | { kind: 'reject'; reason: RejectReason; message: string };

export type RejectReason =
  | 'no_fixture'
  | 'unknown_entity'
  | 'unsupported_claim_type'
  | 'monetary_forfeit'
  | 'window_closed'
  | 'out_of_range'
  | 'unresolvable';

// ── Settlement (pure reducer) ─────────────────────────────────────────────

export interface MarketState {
  marketId: string;
  spec: MarketSpec;
  status: MarketStatus;
  positions: Position[];
  /** Set when a candidate settling event is in its debounce window. */
  pendingSettlement: {
    outcome: SettlementOutcome;
    decidingSeq: number;
    evidenceSeqs: number[];
    debounceUntilMs: number;
  } | null;
  createdAtMs: number;
}

export type SettlementOutcome = 'claim_won' | 'claim_lost' | 'void';

export type MarketEffect =
  | { kind: 'freeze'; reason: 'var' | 'possible_event' | 'odds_suspension' | 'cutoff' }
  | { kind: 'unfreeze' }
  | { kind: 'settle'; outcome: SettlementOutcome; decidingSeq: number; evidenceSeqs: number[] }
  | { kind: 'void'; reason: string }
  | { kind: 'void_positions'; positionIds: string[]; reason: 'delay_snipe' }
  | { kind: 'activate_positions'; positionIds: string[] }
  | { kind: 'activate_market' }
  | { kind: 'reprice_hint' };

export interface ReduceResult {
  state: MarketState;
  effects: MarketEffect[];
}
