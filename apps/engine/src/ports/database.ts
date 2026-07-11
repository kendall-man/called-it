import type {
  MarketSpec,
  MarketStatus,
  MatchEvent,
  PositionSide,
  SettlementOutcome,
  TrustTier,
} from '@calledit/market-engine';
import type { Chattiness } from '../localTypes.js';
import type {
  ApplyGroupPointsResult,
  ClaimRow,
  BotGroupReadyMarkerResult,
  ClaimStatus,
  FixtureRow,
  FixtureUpsert,
  GroupRow,
  GroupPlayerStats,
  LeaderboardEntry,
  LedgerEntry,
  MembershipRow,
  MarketRow,
  PlayerLite,
  PointResult,
  PositionParticipant,
  PositionRow,
  SettlementRow,
  UserRow,
} from './rows.js';

export interface EngineDb {
  upsertGroup(input: { id: number; title: string }): Promise<GroupRow>;
  getGroup(id: number): Promise<GroupRow | null>;
  markGroupReady?(input: {
    groupId: number;
    onboardingVersion: 'calledit_v1';
  }): Promise<BotGroupReadyMarkerResult>;
  setGroupChattiness(id: number, chattiness: Chattiness): Promise<void>;
  setGroupAdmin(id: number, isAdmin: boolean): Promise<void>;
  setGroupWebEnabled(id: number, enabled: boolean): Promise<void>;
  listGroups(): Promise<GroupRow[]>;

  upsertUser(input: { id: number; display_name: string; username: string | null }): Promise<void>;
  getUser(id: number): Promise<UserRow | null>;
  ensureMembership(groupId: number, userId: number): Promise<{ created: boolean }>;
  listMemberships(groupId: number): Promise<MembershipRow[]>;
  balance(groupId: number, userId: number): Promise<number>;
  applyGroupPoints(marketId: string): Promise<ApplyGroupPointsResult>;
  pointResultsForMarket(marketId: string): Promise<readonly PointResult[]>;
  groupPlayerStats(groupId: number, userId: number): Promise<GroupPlayerStats>;
  leaderboard(groupId: number, limit: number): Promise<readonly LeaderboardEntry[]>;
  positionParticipantsForMarket(marketId: string): Promise<readonly PositionParticipant[]>;

  postLedger(entry: LedgerEntry): Promise<{ inserted: boolean }>;
  hasLedgerEntry(idempotencyKey: string): Promise<boolean>;

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
  expireOverdueClaims(nowIso: string): Promise<ClaimRow[]>;

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
    currency?: 'rep' | 'sol';
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
  openMarketsForFixture(fixtureId: number): Promise<MarketRow[]>;
  openMarketsForGroup(groupId: number): Promise<MarketRow[]>;

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

  insertFeedEvent(event: MatchEvent): Promise<{ inserted: boolean }>;

  insertSettlement(input: {
    market_id: string;
    outcome: SettlementOutcome;
    deciding_seq: number | null;
    evidence_seqs: number[];
    tier: TrustTier;
  }): Promise<void>;
  unpostedSettlements(): Promise<SettlementRow[]>;
  markSettlementPosted(marketId: string): Promise<void>;

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

  getCursor(streamName: string): Promise<string | null>;
  setCursor(streamName: string, lastEventId: string): Promise<void>;

  upsertFixtures(rows: FixtureUpsert[]): Promise<void>;
  getFixture(fixtureId: number): Promise<FixtureRow | null>;
  fixturesBetween(fromMs: number, toMs: number): Promise<FixtureRow[]>;
  liveFixtures(nowMs: number, lookaheadMs: number): Promise<FixtureRow[]>;
  updateFixtureFromEvent(event: MatchEvent): Promise<void>;
  searchFixtures(query: string): Promise<FixtureRow[]>;
  entityNames(): Promise<{ teamNames: string[]; playerNames: string[] }>;
  playersForFixture(fixtureId: number): Promise<PlayerLite[]>;
  searchPlayers(name: string, fixtureId?: number): Promise<PlayerLite[]>;
}
