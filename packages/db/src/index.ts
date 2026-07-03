/**
 * @calledit/db — thin typed data façade over Supabase for the Called It
 * engine. Exposes createEngineDb (service-role writes, RLS bypass) plus the
 * hand-written row types that mirror migrations/0001_init.sql.
 */

export { createEngineDb, type EngineDb } from './engine-db.js';
export { DbError } from './errors.js';
export type {
  Chattiness,
  ClaimInsert,
  ClaimPatch,
  ClaimRow,
  ClaimStatus,
  EntityNames,
  FeedEventRow,
  FixturePlayerRow,
  FixtureRow,
  FixtureUpsert,
  GroupRow,
  LeaderboardEntry,
  LedgerEntry,
  LedgerKind,
  LedgerRow,
  MarketInsert,
  MarketQuotePatch,
  MarketRow,
  MembershipRow,
  PlayerLite,
  PlayerRow,
  PositionInsert,
  PositionRow,
  PositionState,
  PriceProvenance,
  ProofKind,
  ProofRow,
  ProofStatus,
  ProofUpsert,
  SettlementInsert,
  SettlementRow,
  StreamCursorRow,
  UserRow,
} from './types.js';
