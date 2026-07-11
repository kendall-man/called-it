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
  parsePositionParticipants,
} from './group-points-query-parsers.js';

const MAX_LEADERBOARD_LIMIT = 100;

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
      const response = await client
        .from('group_point_events')
        .select(
          'group_id,market_id,user_id,side,result,points_delta,user:users!inner(display_name,username)',
        )
        .eq('market_id', marketId)
        .order('points_delta', { ascending: false })
        .order('user_id', { ascending: true });
      return parsePointResults(rows(GROUP_POINTS_QUERY_OPS.pointResults, response), marketId);
    },

    async groupPlayerStats(groupId, userId) {
      assertSafeInput(GROUP_POINTS_QUERY_OPS.playerStats, 'group_id', groupId);
      assertPositiveInput(GROUP_POINTS_QUERY_OPS.playerStats, 'user_id', userId);
      const response = await client
        .from('group_player_stats')
        .select('group_id,user_id,points,wins,losses,current_streak,best_streak')
        .eq('group_id', groupId)
        .eq('user_id', userId)
        .maybeSingle();
      const data = responseData(GROUP_POINTS_QUERY_OPS.playerStats, response);
      if (data === null) {
        return {
          group_id: groupId,
          user_id: userId,
          points: 0,
          wins: 0,
          losses: 0,
          accuracy: 0,
          current_streak: 0,
          best_streak: 0,
        };
      }
      return parsePlayerStats(data, groupId, userId);
    },

    async leaderboard(groupId, limit) {
      assertSafeInput(GROUP_POINTS_QUERY_OPS.leaderboard, 'group_id', groupId);
      assertLeaderboardLimit(limit);
      const response = await client
        .from('group_player_stats')
        .select(
          'group_id,user_id,points,wins,losses,current_streak,best_streak,user:users!inner(display_name,username)',
        )
        .eq('group_id', groupId)
        .order('points', { ascending: false })
        .order('wins', { ascending: false })
        .order('losses', { ascending: true })
        .order('user_id', { ascending: true })
        .limit(limit);
      const values = rows(GROUP_POINTS_QUERY_OPS.leaderboard, response);
      if (values.length > limit) {
        return contractFailure(GROUP_POINTS_QUERY_OPS.leaderboard, '<rows>');
      }
      return parseLeaderboard(values, groupId);
    },

    async positionParticipantsForMarket(marketId) {
      const response = await client
        .from('positions')
        .select(
          'market_id,user_id,side,placed_at_ms,market:markets!inner(id,group_id),user:users!inner(display_name,username)',
        )
        .eq('market_id', marketId)
        .eq('state', 'active')
        .order('placed_at_ms', { ascending: true })
        .order('user_id', { ascending: true })
        .order('side', { ascending: true });
      return parsePositionParticipants(
        rows(GROUP_POINTS_QUERY_OPS.participants, response),
        marketId,
      );
    },
  } satisfies GroupPointsQueryDb;
}

function assertLeaderboardLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LEADERBOARD_LIMIT) {
    contractFailure(GROUP_POINTS_QUERY_OPS.leaderboard, 'limit');
  }
}
