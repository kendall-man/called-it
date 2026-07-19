import type { GroupPointsDb, GroupPointsDbClient } from './group-points-contract.js';
import {
  assertPositiveInput,
  assertSafeInput,
  contractFailure,
  responseData,
  rows,
} from './group-points-parser-core.js';
import {
  GROUP_POINTS_QUERY_OPS,
  parseLeaderboard,
  parsePlayerStats,
  parsePointResults,
} from './group-points-query-parsers.js';
import { parsePositionParticipants } from './group-points-participant-parser.js';
import { canonicalGroupLeaderboardFallback } from './group-points-canonical-fallback.js';

const MAX_LEADERBOARD_LIMIT = 100;
const POINT_RESULT_LIMIT = 10;
const POINT_RESULT_SELECT =
  'group_id,market_id,user_id,side,result,points_delta,user:users!inner(display_name,username)';
const PARTICIPANT_ROW_LIMIT = 10;
const PARTICIPANT_RPC = 'group_market_participants';
const EVENT_STATS_VIEW = 'group_player_stats_from_events';
const STATS_COLUMNS = 'group_id,user_id,points,wins,losses,current_streak,best_streak';
const EVENT_LEADERBOARD_COLUMNS = `${STATS_COLUMNS},user`;

type GroupPointsQueryDb = Pick<
  GroupPointsDb,
  | 'pointResultsForMarket'
  | 'groupPlayerStats'
  | 'leaderboard'
  | 'positionParticipantsForMarket'
>;

export function groupPointsQueryMethods(client: GroupPointsDbClient): GroupPointsQueryDb {
  return {
    async pointResultsForMarket(marketId) {
      const [wonRows, lostRows] = await Promise.all([
        pointResultRows(client, marketId, 'won'),
        pointResultRows(client, marketId, 'lost'),
      ]);
      return parsePointResults([...wonRows, ...lostRows], marketId);
    },

    async groupPlayerStats(groupId, userId) {
      assertSafeInput(GROUP_POINTS_QUERY_OPS.playerStats, 'group_id', groupId);
      assertPositiveInput(GROUP_POINTS_QUERY_OPS.playerStats, 'user_id', userId);
      const response = await playerStatsResponse(client, EVENT_STATS_VIEW, groupId, userId);
      if (statsViewUnavailable(response)) {
        const entries = await canonicalGroupLeaderboardFallback(client, groupId);
        const entry = entries.find((candidate) => candidate.user_id === userId);
        return entry === undefined ? zeroStats(groupId, userId) : statsOnly(entry);
      }
      const data = responseData(GROUP_POINTS_QUERY_OPS.playerStats, response);
      if (data === null) return zeroStats(groupId, userId);
      return parsePlayerStats(data, groupId, userId);
    },

    async leaderboard(groupId, limit) {
      assertSafeInput(GROUP_POINTS_QUERY_OPS.leaderboard, 'group_id', groupId);
      assertLeaderboardLimit(limit);
      const response = await leaderboardResponse(
        client,
        EVENT_STATS_VIEW,
        EVENT_LEADERBOARD_COLUMNS,
        groupId,
        limit,
      );
      if (statsViewUnavailable(response)) {
        return (await canonicalGroupLeaderboardFallback(client, groupId)).slice(0, limit);
      }
      const values = rows(GROUP_POINTS_QUERY_OPS.leaderboard, response);
      if (values.length > limit) {
        return contractFailure(GROUP_POINTS_QUERY_OPS.leaderboard, '<rows>');
      }
      return parseLeaderboard(values, groupId);
    },

    async positionParticipantsForMarket(marketId) {
      const response = await client.rpc(PARTICIPANT_RPC, { p_market_id: marketId });
      return parsePositionParticipants(
        boundedRows(GROUP_POINTS_QUERY_OPS.participants, response, PARTICIPANT_ROW_LIMIT),
        marketId,
      );
    },
  } satisfies GroupPointsQueryDb;
}

function zeroStats(groupId: number, userId: number) {
  return {
    group_id: groupId,
    user_id: userId,
    points: 0,
    wins: 0,
    losses: 0,
    accuracy: 0,
    current_streak: 0,
    best_streak: 0,
  } as const;
}

function statsOnly(entry: ReturnType<typeof parseLeaderboard>[number]) {
  return {
    group_id: entry.group_id,
    user_id: entry.user_id,
    points: entry.points,
    wins: entry.wins,
    losses: entry.losses,
    accuracy: entry.accuracy,
    current_streak: entry.current_streak,
    best_streak: entry.best_streak,
  } as const;
}

function playerStatsResponse(
  client: GroupPointsDbClient,
  source: string,
  groupId: number,
  userId: number,
) {
  return client
    .from(source)
    .select(STATS_COLUMNS)
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .maybeSingle();
}

function leaderboardResponse(
  client: GroupPointsDbClient,
  source: string,
  columns: string,
  groupId: number,
  limit: number,
) {
  return client
    .from(source)
    .select(columns)
    .eq('group_id', groupId)
    .order('points', { ascending: false })
    .order('wins', { ascending: false })
    .order('losses', { ascending: true })
    .order('user_id', { ascending: true })
    .limit(limit);
}

function statsViewUnavailable(response: unknown): boolean {
  if (typeof response !== 'object' || response === null || !('error' in response)) return false;
  const error = response.error;
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === '42P01' || error.code === 'PGRST205';
}

async function pointResultRows(
  client: GroupPointsDbClient,
  marketId: string,
  result: 'won' | 'lost',
): Promise<readonly unknown[]> {
  const response = await client
    .from('group_point_events')
    .select(POINT_RESULT_SELECT)
    .eq('market_id', marketId)
    .eq('result', result)
    .order('points_delta', { ascending: false })
    .order('user_id', { ascending: true })
    .limit(POINT_RESULT_LIMIT);
  return boundedRows(GROUP_POINTS_QUERY_OPS.pointResults, response, POINT_RESULT_LIMIT);
}

function boundedRows(op: string, response: unknown, limit: number): readonly unknown[] {
  const values = rows(op, response);
  if (values.length > limit) return contractFailure(op, '<rows>');
  return values;
}

function assertLeaderboardLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LEADERBOARD_LIMIT) {
    contractFailure(GROUP_POINTS_QUERY_OPS.leaderboard, 'limit');
  }
}
