/**
 * Ports: the engine's view of its workspace siblings, per CONTRACTS.md.
 *
 * Every sibling package is consumed through one of these interfaces and
 * constructed in exactly one place (wiring.ts). If a sibling's real surface
 * drifts from CONTRACTS.md, wiring.ts is the only file that needs to adapt.
 *
 * Row shapes mirror packages/db/migrations/0001_init.sql (snake_case, same
 * column names) so the @calledit/db façade should satisfy EngineDb directly.
 */

import type {
  Comparator,
  CompileContext,
  CompileResult,
  GamePhase,
  MarketSpec,
  MarketState,
  MarketStatus,
  MatchEvent,
  OddsInputs,
  PositionSide,
  PriceQuote,
  RawClaimParse,
  ReduceResult,
  SettlementOutcome,
  TrustTier,
} from '@calledit/market-engine';
import type { Chattiness } from './localTypes.js';
import type { Env } from './env.js';
import type { Logger } from './log.js';

// ── Row shapes (matching migrations/0001_init.sql) ────────────────────────

export type ClaimStatus =
  | 'detected'
  | 'nudged'
  | 'clarifying'
  | 'awaiting_confirm'
  | 'confirmed'
  | 'declined'
  | 'expired';

export interface GroupRow {
  id: number;
  title: string;
  slug: string;
  web_enabled: boolean;
  chattiness: Chattiness;
  is_admin: boolean;
}

export interface UserRow {
  id: number;
  display_name: string;
  username: string | null;
}

export interface MembershipRow {
  group_id: number;
  user_id: number;
  points_cached: number;
  streak: number;
}

export interface FixtureRow {
  fixture_id: number;
  p1_name: string;
  p2_name: string;
  kickoff_at: string | null;
  phase: GamePhase;
  minute: number | null;
  last_seq: number;
  /** Normalized ScoreState jsonb written back from feed events. */
  score: Record<string, unknown>;
  coverage_unreliable: boolean;
}

export interface FixtureUpsert {
  fixture_id: number;
  competition_id: number | null;
  p1_id: number | null;
  p1_name: string;
  p2_id: number | null;
  p2_name: string;
  kickoff_at: string | null;
}

export interface ClaimRow {
  id: string;
  group_id: number;
  claimer_user_id: number;
  tg_message_id: number;
  quoted_text: string;
  status: ClaimStatus;
  classifier_confidence: number | null;
  /** jsonb envelope: RawClaimParse plus compiled candidate specs (see pipeline). */
  parse: unknown;
  expires_at: string | null;
  created_at: string;
}

export interface MarketRow {
  id: string;
  claim_id: string;
  group_id: number;
  fixture_id: number;
  spec: MarketSpec;
  status: MarketStatus;
  is_replay: boolean;
  price_provenance: 'market' | 'modelled';
  quote_probability: number;
  quote_multiplier: number;
  odds_message_id: string | null;
  odds_ts: number | null;
  card_tg_message_id: number | null;
  created_at: string;
}

export interface PositionRow {
  id: string;
  market_id: string;
  user_id: number;
  side: PositionSide;
  stake: number;
  locked_multiplier: number;
  state: 'pending' | 'active' | 'void';
  placed_at_ms: number;
}

export interface SettlementRow {
  market_id: string;
  outcome: SettlementOutcome;
  deciding_seq: number | null;
  evidence_seqs: number[];
  tier: TrustTier;
  posted_at: string | null;
  settled_at: string;
}

export interface PlayerLite {
  normativeId: number;
  name: string;
  participant: 1 | 2 | null;
}

export type LedgerKind = 'stake' | 'payout' | 'refund' | 'topup' | 'seed';

export interface LedgerEntry {
  group_id: number;
  user_id: number;
  market_id: string | null;
  kind: LedgerKind;
  /** Signed Rep delta. */
  amount: number;
  idempotency_key: string;
}

// ── @calledit/db façade ───────────────────────────────────────────────────

export interface EngineDb {
  // groups
  upsertGroup(input: { id: number; title: string }): Promise<GroupRow>;
  getGroup(id: number): Promise<GroupRow | null>;
  setGroupChattiness(id: number, chattiness: Chattiness): Promise<void>;
  setGroupAdmin(id: number, isAdmin: boolean): Promise<void>;
  setGroupWebEnabled(id: number, enabled: boolean): Promise<void>;
  listGroups(): Promise<GroupRow[]>;

  // users & memberships
  upsertUser(input: { id: number; display_name: string; username: string | null }): Promise<void>;
  getUser(id: number): Promise<UserRow | null>;
  /** Creates the membership row if missing; created=true on first interaction. */
  ensureMembership(groupId: number, userId: number): Promise<{ created: boolean }>;
  listMemberships(groupId: number): Promise<MembershipRow[]>;
  /** Ledger-derived balance (source of truth, not the display cache). */
  balance(groupId: number, userId: number): Promise<number>;
  leaderboard(
    groupId: number,
    limit: number,
  ): Promise<Array<{ user_id: number; display_name: string; points_cached: number; streak: number }>>;

  // ledger
  /** Idempotent append; inserted=false when the idempotency key already exists. */
  postLedger(entry: LedgerEntry): Promise<{ inserted: boolean }>;

  // claims
  insertClaim(input: {
    group_id: number;
    claimer_user_id: number;
    tg_message_id: number;
    quoted_text: string;
    status: ClaimStatus;
    classifier_confidence: number | null;
    expires_at: string | null;
  }): Promise<ClaimRow>;
  getClaim(id: string): Promise<ClaimRow | null>;
  updateClaim(
    id: string,
    patch: Partial<{ status: ClaimStatus; parse: unknown; expires_at: string | null }>,
  ): Promise<void>;
  /** Flip overdue non-terminal claims to 'expired'; returns the rows expired. */
  expireOverdueClaims(nowIso: string): Promise<ClaimRow[]>;

  // markets
  insertMarket(input: {
    claim_id: string;
    group_id: number;
    fixture_id: number;
    spec: MarketSpec;
    status: MarketStatus;
    is_replay: boolean;
    price_provenance: 'market' | 'modelled';
    quote_probability: number;
    quote_multiplier: number;
    odds_message_id: string | null;
    odds_ts: number | null;
  }): Promise<MarketRow>;
  getMarket(id: string): Promise<MarketRow | null>;
  updateMarketStatus(id: string, status: MarketStatus): Promise<void>;
  setMarketQuote(
    id: string,
    quote: {
      quote_probability: number;
      quote_multiplier: number;
      odds_message_id: string | null;
      odds_ts: number | null;
    },
  ): Promise<void>;
  setMarketCardMessage(id: string, tgMessageId: number): Promise<void>;
  /** Markets in a non-terminal status (pending_lineup/open/frozen/settling). */
  openMarketsForFixture(fixtureId: number): Promise<MarketRow[]>;
  openMarketsForGroup(groupId: number): Promise<MarketRow[]>;

  // positions
  insertPosition(input: {
    market_id: string;
    user_id: number;
    side: PositionSide;
    stake: number;
    locked_multiplier: number;
    locked_odds_message_id: string | null;
    locked_odds_ts: number | null;
    state: 'pending' | 'active';
    placed_at_ms: number;
  }): Promise<PositionRow>;
  positionsForMarket(marketId: string): Promise<PositionRow[]>;
  setPositionStates(ids: string[], state: 'pending' | 'active' | 'void'): Promise<void>;

  // feed events
  /** Upsert-ignore on (fixture_id, seq); inserted=false on duplicate. */
  insertFeedEvent(event: MatchEvent): Promise<{ inserted: boolean }>;

  // settlements
  insertSettlement(input: {
    market_id: string;
    outcome: SettlementOutcome;
    deciding_seq: number | null;
    evidence_seqs: number[];
    tier: TrustTier;
  }): Promise<void>;
  unpostedSettlements(): Promise<SettlementRow[]>;
  markSettlementPosted(marketId: string): Promise<void>;

  // proofs
  upsertProof(input: {
    market_id: string;
    kind: 'stat' | 'odds';
    stat_key: number | null;
    seq: number | null;
    merkle_proof: unknown;
    validate_stat_tx: string | null;
    explorer_url: string | null;
    status: 'pending' | 'verified' | 'failed' | 'unavailable';
  }): Promise<void>;

  // stream cursors (LiveSource resume)
  getCursor(streamName: string): Promise<string | null>;
  setCursor(streamName: string, lastEventId: string): Promise<void>;

  // fixtures & players
  upsertFixtures(rows: FixtureUpsert[]): Promise<void>;
  getFixture(fixtureId: number): Promise<FixtureRow | null>;
  /** Fixtures with kickoff_at inside [fromMs, toMs). */
  fixturesBetween(fromMs: number, toMs: number): Promise<FixtureRow[]>;
  /** In a live phase, or NS with kickoff within lookaheadMs of nowMs. */
  liveFixtures(nowMs: number, lookaheadMs: number): Promise<FixtureRow[]>;
  /** Apply a normalized event's phase/minute/score/last_seq to the fixture row. */
  updateFixtureFromEvent(event: MatchEvent): Promise<void>;
  /** Name-substring fixture search used by the agent's grounded tools. */
  searchFixtures(query: string): Promise<FixtureRow[]>;
  /** Team + player dictionary for the deterministic prefilter. */
  entityNames(): Promise<{ teamNames: string[]; playerNames: string[] }>;
  playersForFixture(fixtureId: number): Promise<PlayerLite[]>;
  searchPlayers(name: string, fixtureId?: number): Promise<PlayerLite[]>;
}

// ── @calledit/agent ───────────────────────────────────────────────────────

export interface EntityHints {
  teamNames: string[];
  playerNames: string[];
}

export interface ClassifyResult {
  isClaim: boolean;
  confidence: number;
  claimTypeGuess: string | null;
}

export interface AgentPort {
  prefilter(text: string, entities: EntityHints): boolean;
  classify(text: string, entities: EntityHints): Promise<ClassifyResult>;
  parse(text: string, ctx: CompileContext): Promise<RawClaimParse>;
  persona(templateKey: string, vars: Record<string, string | number>): Promise<string>;
}

// ── @calledit/market-engine pure functions ────────────────────────────────

export interface EnginePort {
  compileClaim(parse: RawClaimParse, ctx: CompileContext): CompileResult;
  priceSpec(spec: MarketSpec, odds: OddsInputs, ctx: CompileContext): PriceQuote;
  reduceMarket(state: MarketState, event: MatchEvent): ReduceResult;
  checkDebounce(state: MarketState, nowMs: number): ReduceResult;
}

// ── @calledit/txline ──────────────────────────────────────────────────────

export interface EventSourceLike {
  start(onEvent: (event: MatchEvent) => Promise<void>): void;
  stop(): void;
}

/**
 * Discriminated odds-fetch result so callers can tell a transient failure
 * (retry may help) from a fixture the feed simply has no usable lines for
 * (retry is pointless until the desk publishes).
 */
export type OddsFetchResult =
  | { kind: 'ok'; odds: OddsInputs }
  | { kind: 'no_odds' }
  | { kind: 'transient' };

export interface TxPort {
  /** Latest odds snapshot, normalized, with failure-reason taxonomy. */
  fetchOdds(fixtureId: number): Promise<OddsFetchResult>;
  /** Fixtures snapshot mapped to upsert rows (defensive field mapping). */
  fetchFixtures(): Promise<FixtureUpsert[]>;
  /** Raw stat-validation payload (Merkle proof) for a settled stat. */
  fetchStatProof(fixtureId: number, seq: number, statKey: number): Promise<unknown>;
  createLiveSource(fixtureId: number): EventSourceLike;
  createReplaySource(fixtureId: number, speed: number): EventSourceLike;
}

// ── @calledit/solana ──────────────────────────────────────────────────────

export interface ProofSubmission {
  fixtureId: number;
  seq: number;
  statKey: number;
  /** The settled spec's predicate, asserted on-chain via validate_stat. */
  comparator: Comparator;
  threshold: number;
  /** Raw stat-validation response from packages/txline. */
  proof: unknown;
}

export interface ProofSubmitResult {
  ok: boolean;
  txSig?: string;
  error?: string;
  /** true = retrying cannot help (unmappable payload, no wallet, …). */
  permanent?: boolean;
}

export interface ProofSubmitter {
  submit(args: ProofSubmission): Promise<ProofSubmitResult>;
}

// ── Aggregate dependency bundle ───────────────────────────────────────────

export interface Deps {
  db: EngineDb;
  agent: AgentPort;
  engine: EnginePort;
  tx: TxPort;
  /** null when SOLANA_KEYPAIR_B58 is absent — proofs degrade honestly. */
  proofSubmitter: ProofSubmitter | null;
  env: Env;
  log: Logger;
  now(): number;
}
