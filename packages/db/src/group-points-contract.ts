import { DbError, type PgResult } from './errors.js';
import type {
  ApplyGroupPointsResult,
  GroupPlayerStats,
  LeaderboardEntry,
  PointResult,
  PositionParticipant,
} from './group-points-types.js';

export interface GroupPointsFilterBuilder extends PromiseLike<PgResult<unknown>> {
  eq(column: string, value: unknown): GroupPointsFilterBuilder;
  neq(column: string, value: unknown): GroupPointsFilterBuilder;
  order(column: string, options: { readonly ascending: boolean }): GroupPointsFilterBuilder;
  limit(value: number): GroupPointsFilterBuilder;
  maybeSingle(): PromiseLike<PgResult<unknown>>;
}

export interface GroupPointsTableBuilder {
  select(columns: string): GroupPointsFilterBuilder;
}

export interface GroupPointsDbClient {
  from(table: string): GroupPointsTableBuilder;
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<PgResult<unknown>>;
}

export interface GroupPointsDb {
  applyGroupPoints(marketId: string): Promise<ApplyGroupPointsResult>;
  pointResultsForMarket(marketId: string): Promise<readonly PointResult[]>;
  groupPlayerStats(groupId: number, userId: number): Promise<GroupPlayerStats>;
  leaderboard(groupId: number, limit: number): Promise<readonly LeaderboardEntry[]>;
  positionParticipantsForMarket(marketId: string): Promise<readonly PositionParticipant[]>;
}

export function requireGroupPointsDbClient(value: unknown): GroupPointsDbClient {
  if (isGroupPointsDbClient(value)) return value;
  throw new DbError('groupPointsDbFromClient', { message: 'malformed Supabase client' });
}

function isGroupPointsDbClient(value: unknown): value is GroupPointsDbClient {
  return (
    typeof value === 'object' &&
    value !== null &&
    'from' in value &&
    typeof value.from === 'function' &&
    'rpc' in value &&
    typeof value.rpc === 'function'
  );
}
