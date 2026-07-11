import type { GroupPointsDb, GroupPointsDbClient } from './group-points-contract.js';
import {
  assertPositiveInput,
  assertSafeInput,
  countField,
  contractFailure,
  positionSide,
  positiveIntegerField,
  record,
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
const POINT_RESULT_LIMIT = 10;
const POINT_RESULT_SELECT =
  'group_id,market_id,user_id,side,result,points_delta,user:users!inner(display_name,username)';
const PARTICIPANT_LIMIT = 5;
const PARTICIPANT_SELECT =
  'market_id,user_id,side,placed_at_ms,market:markets!inner(id,group_id),user:users!inner(display_name,username)';

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
      const [backRows, doubtRows] = await Promise.all([
        participantRows(client, marketId, 'back'),
        participantRows(client, marketId, 'doubt'),
      ]);
      return parsePositionParticipants(mergeParticipantRows(backRows, doubtRows), marketId);
    },
  } satisfies GroupPointsQueryDb;
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

async function participantRows(
  client: GroupPointsDbClient,
  marketId: string,
  side: 'back' | 'doubt',
): Promise<readonly unknown[]> {
  const response = await client
    .from('positions')
    .select(PARTICIPANT_SELECT)
    .eq('market_id', marketId)
    .eq('side', side)
    .neq('state', 'void')
    .order('placed_at_ms', { ascending: true })
    .order('user_id', { ascending: true })
    .order('side', { ascending: true })
    .limit(PARTICIPANT_LIMIT);
  return boundedRows(GROUP_POINTS_QUERY_OPS.participants, response, PARTICIPANT_LIMIT);
}

function boundedRows(op: string, response: unknown, limit: number): readonly unknown[] {
  const values = rows(op, response);
  if (values.length > limit) return contractFailure(op, '<rows>');
  return values;
}

function mergeParticipantRows(
  backRows: readonly unknown[],
  doubtRows: readonly unknown[],
): readonly unknown[] {
  const merged: unknown[] = [];
  let backIndex = 0;
  let doubtIndex = 0;
  while (backIndex < backRows.length && doubtIndex < doubtRows.length) {
    const backRow = backRows[backIndex];
    const doubtRow = doubtRows[doubtIndex];
    if (compareParticipantRows(backRow, doubtRow) <= 0) {
      merged.push(backRow);
      backIndex += 1;
    } else {
      merged.push(doubtRow);
      doubtIndex += 1;
    }
  }
  merged.push(...backRows.slice(backIndex), ...doubtRows.slice(doubtIndex));
  return merged;
}

function compareParticipantRows(left: unknown, right: unknown): number {
  const op = GROUP_POINTS_QUERY_OPS.participants;
  const leftRow = record(op, left);
  const rightRow = record(op, right);
  const placedAtDifference =
    countField(op, leftRow, 'placed_at_ms') - countField(op, rightRow, 'placed_at_ms');
  if (placedAtDifference !== 0) return placedAtDifference;
  const userIdDifference =
    positiveIntegerField(op, leftRow, 'user_id') - positiveIntegerField(op, rightRow, 'user_id');
  if (userIdDifference !== 0) return userIdDifference;
  return positionSide(op, leftRow.side).localeCompare(positionSide(op, rightRow.side));
}

function assertLeaderboardLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LEADERBOARD_LIMIT) {
    contractFailure(GROUP_POINTS_QUERY_OPS.leaderboard, 'limit');
  }
}
