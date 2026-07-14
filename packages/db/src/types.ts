/**
 * Hand-written row shapes mirroring packages/db/migrations/0001_init.sql.
 *
 * Column names stay snake_case and match the migration exactly so rows can
 * flow straight from PostgREST to the engine without any mapping layer
 * (apps/engine/src/ports.ts codes against these shapes structurally).
 *
 * Timestamps (timestamptz) arrive as ISO-8601 strings; bigint columns arrive
 * as JS numbers (Telegram ids and feed seqs fit comfortably below 2^53).
 */

import type {
  GamePhase,
  MarketCurrency,
  MarketSpec,
  MarketStatus,
  MatchEventKind,
  SettlementOutcome,
  TrustTier,
} from '@calledit/market-engine';

export type { MarketCurrency } from '@calledit/market-engine';

export type * from './group-points-types.js';

// ── Enumerations backed by CHECK constraints in the migration ─────────────

export type Chattiness = 'nudge' | 'react_only' | 'trigger_only';

export type ClaimStatus =
  | 'detected'
  | 'nudged'
  | 'clarifying'
  | 'awaiting_confirm'
  | 'confirmed'
  | 'declined'
  | 'expired';

export type LedgerKind = 'stake' | 'payout' | 'refund' | 'topup' | 'seed';

export type PriceProvenance = 'market' | 'modelled';

export type ProofKind = 'stat' | 'odds';

export type ProofStatus = 'pending' | 'verified' | 'failed' | 'unavailable';

// ── Table rows ─────────────────────────────────────────────────────────────

export interface GroupRow {
  id: number;
  title: string;
  slug: string;
  web_enabled: boolean;
  chattiness: Chattiness;
  is_admin: boolean;
  created_at: string;
}

export interface UserRow {
  id: number;
  display_name: string;
  username: string | null;
  first_seen_at: string;
}

export interface MembershipRow {
  group_id: number;
  user_id: number;
  points_cached: number;
  last_topup_at: string | null;
  streak: number;
}

export interface LedgerRow {
  id: number;
  group_id: number;
  user_id: number;
  market_id: string | null;
  kind: LedgerKind;
  /** Signed Rep delta. */
  amount: number;
  idempotency_key: string;
  created_at: string;
}

export interface FixtureRow {
  fixture_id: number;
  competition_id: number | null;
  p1_id: number | null;
  p1_name: string;
  p2_id: number | null;
  p2_name: string;
  kickoff_at: string | null;
  phase: GamePhase;
  minute: number | null;
  /** Settlement watermark: seq of the last feed event applied to this row. */
  last_seq: number;
  /** Normalized ScoreState jsonb written back from feed events. */
  score: Record<string, unknown>;
  coverage_unreliable: boolean;
  updated_at: string;
}

export interface PlayerRow {
  normative_id: number;
  preferred_name: string;
  team: string | null;
  aliases: string[];
  updated_at: string;
}

export interface FixturePlayerRow {
  fixture_id: number;
  fixture_player_id: number;
  normative_id: number | null;
  participant: 1 | 2 | null;
  roster_number: number | null;
  starter: boolean;
}

export interface ClaimRow {
  id: string;
  group_id: number;
  claimer_user_id: number;
  tg_message_id: number;
  quoted_text: string;
  status: ClaimStatus;
  classifier_confidence: number | null;
  /** jsonb envelope: RawClaimParse plus compiled candidate specs. */
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
  /**
   * Stake currency, stamped atomically at mint (migration 0002). Optional so
   * pre-0002 databases and existing fixtures stay valid; absent means 'rep'.
   */
  currency?: MarketCurrency;
  price_provenance: PriceProvenance;
  quote_probability: number;
  quote_multiplier: number;
  odds_message_id: string | null;
  odds_ts: number | null;
  card_tg_message_id: number | null;
  created_at: string;
}

export interface FeedEventRow {
  fixture_id: number;
  seq: number;
  ts_ms: number;
  received_at_ms: number;
  kind: MatchEventKind;
  confirmed: boolean;
  /** Normalized MatchEvent (derived facts, never raw TxLINE payloads). */
  payload: Record<string, unknown>;
  inserted_at: string;
}

export interface SettlementRow {
  market_id: string;
  outcome: SettlementOutcome;
  deciding_seq: number | null;
  evidence_seqs: number[];
  tier: TrustTier;
  /** null = chat delivery pending (settlement sweeper re-sends). */
  posted_at: string | null;
  settled_at: string;
}

export interface ProofRow {
  id: string;
  market_id: string;
  kind: ProofKind;
  stat_key: number | null;
  seq: number | null;
  merkle_proof: unknown;
  validate_stat_tx: string | null;
  explorer_url: string | null;
  status: ProofStatus;
  verified_at: string | null;
}

export interface StreamCursorRow {
  stream_name: string;
  last_event_id: string | null;
  updated_at: string;
}

// ── Write inputs (subsets of rows the engine supplies; DB fills defaults) ──

export interface LedgerEntry {
  group_id: number;
  user_id: number;
  market_id: string | null;
  kind: LedgerKind;
  /** Signed Rep delta. */
  amount: number;
  idempotency_key: string;
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

export interface ClaimInsert {
  group_id: number;
  claimer_user_id: number;
  tg_message_id: number;
  quoted_text: string;
  status: ClaimStatus;
  classifier_confidence: number | null;
  expires_at: string | null;
}

export type ClaimPatch = Partial<{
  status: ClaimStatus;
  parse: unknown;
  expires_at: string | null;
}>;

export interface MarketInsert {
  claim_id: string;
  group_id: number;
  fixture_id: number;
  spec: MarketSpec;
  status: MarketStatus;
  is_replay: boolean;
  /** Omitted = DB default 'rep'; wager groups stamp 'sol' atomically at mint. */
  currency?: MarketCurrency;
  price_provenance: PriceProvenance;
  quote_probability: number;
  quote_multiplier: number;
  odds_message_id: string | null;
  odds_ts: number | null;
}

export interface MarketQuotePatch {
  quote_probability: number;
  quote_multiplier: number;
  odds_message_id: string | null;
  odds_ts: number | null;
}

export interface SettlementInsert {
  market_id: string;
  outcome: SettlementOutcome;
  deciding_seq: number | null;
  evidence_seqs: number[];
  tier: TrustTier;
}

export interface ProofUpsert {
  market_id: string;
  kind: ProofKind;
  stat_key: number | null;
  seq: number | null;
  merkle_proof: unknown;
  validate_stat_tx: string | null;
  explorer_url: string | null;
  status: ProofStatus;
}

// ── Read projections ───────────────────────────────────────────────────────

/** Flattened player projection used by the agent's grounded tools. */
export interface PlayerLite {
  normativeId: number;
  name: string;
  participant: 1 | 2 | null;
}

export interface EntityNames {
  teamNames: string[];
  playerNames: string[];
}
