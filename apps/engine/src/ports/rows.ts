import type {
  GamePhase,
  MarketSpec,
  MarketStatus,
  PositionSide,
  SettlementOutcome,
  TrustTier,
} from '@calledit/market-engine';
import type { Chattiness } from '../localTypes.js';

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

export type BotGroupReadyMarkerResult =
  | {
      readonly ok: true;
      readonly created: boolean;
      readonly groupId: number;
      readonly onboardingVersion: 'calledit_v1';
    }
  | { readonly ok: false; readonly code: 'invalid_input' | 'group_not_found' };

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
  currency?: 'rep' | 'sol';
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
  amount: number;
  idempotency_key: string;
}
