import {
  contractFailure,
  countField,
  nullableStringField,
  positionSide,
  positiveIntegerField,
  record,
  safeIntegerField,
  stringField,
  type DatabaseRow,
} from './group-points-parser-core.js';
import type {
  GroupPlayerStats,
  LeaderboardEntry,
  PointResult,
  PositionParticipant,
} from './group-points-types.js';

export const GROUP_POINTS_QUERY_OPS = {
  pointResults: 'pointResultsForMarket',
  playerStats: 'groupPlayerStats',
  leaderboard: 'leaderboard',
  participants: 'positionParticipantsForMarket',
} as const;

export function parsePointResults(
  values: readonly unknown[],
  marketId: string,
): readonly PointResult[] {
  const results = values.map((value) => parsePointResult(value, marketId));
  const userIds = new Set<number>();
  const first = results[0];
  let previous: PointResult | undefined;
  for (const result of results) {
    if (first !== undefined && result.group_id !== first.group_id) {
      return contractFailure(GROUP_POINTS_QUERY_OPS.pointResults, 'group_id');
    }
    if (userIds.has(result.user_id)) {
      return contractFailure(GROUP_POINTS_QUERY_OPS.pointResults, 'user_id');
    }
    userIds.add(result.user_id);
    if (
      previous !== undefined &&
      (previous.points_delta < result.points_delta ||
        (previous.points_delta === result.points_delta && previous.user_id > result.user_id))
    ) {
      return contractFailure(GROUP_POINTS_QUERY_OPS.pointResults, '<order>');
    }
    previous = result;
  }
  return results;
}

export function parsePlayerStats(
  value: unknown,
  groupId: number,
  userId: number,
): GroupPlayerStats {
  return parseStatsRecord(record(GROUP_POINTS_QUERY_OPS.playerStats, value), {
    op: GROUP_POINTS_QUERY_OPS.playerStats,
    groupId,
    userId,
  });
}

export function parseLeaderboard(
  values: readonly unknown[],
  groupId: number,
): readonly LeaderboardEntry[] {
  const entries = values.map((value) => parseLeaderboardEntry(value, groupId));
  const userIds = new Set<number>();
  let previous: LeaderboardEntry | undefined;
  for (const entry of entries) {
    if (userIds.has(entry.user_id)) {
      return contractFailure(GROUP_POINTS_QUERY_OPS.leaderboard, 'user_id');
    }
    userIds.add(entry.user_id);
    if (previous !== undefined && isLeaderboardOutOfOrder(previous, entry)) {
      return contractFailure(GROUP_POINTS_QUERY_OPS.leaderboard, '<order>');
    }
    previous = entry;
  }
  return entries;
}

export function parsePositionParticipants(
  values: readonly unknown[],
  marketId: string,
): readonly PositionParticipant[] {
  const parsed = values.map((value) => parseParticipant(value, marketId));
  const participants: PositionParticipant[] = [];
  const seen = new Set<string>();
  let groupId: number | undefined;
  let previous: OrderedParticipant | undefined;
  for (const current of parsed) {
    if (groupId === undefined) groupId = current.participant.group_id;
    if (current.participant.group_id !== groupId) {
      return contractFailure(GROUP_POINTS_QUERY_OPS.participants, 'group_id');
    }
    if (previous !== undefined && compareParticipants(previous, current) > 0) {
      return contractFailure(GROUP_POINTS_QUERY_OPS.participants, '<order>');
    }
    previous = current;
    const key = `${current.participant.user_id}:${current.participant.side}`;
    if (!seen.has(key)) {
      seen.add(key);
      participants.push(current.participant);
    }
  }
  return participants;
}

function parsePointResult(value: unknown, marketId: string): PointResult {
  const op = GROUP_POINTS_QUERY_OPS.pointResults;
  const row = record(op, value);
  const returnedMarketId = stringField(op, row, 'market_id');
  if (returnedMarketId !== marketId) return contractFailure(op, 'market_id');
  const result = pointResult(row.result);
  const pointsDelta = pointDelta(row.points_delta);
  if ((result === 'won') !== (pointsDelta === 10)) {
    return contractFailure(op, 'points_delta');
  }
  const user = record(op, row.user);
  return {
    group_id: safeIntegerField(op, row, 'group_id'),
    market_id: returnedMarketId,
    user_id: positiveIntegerField(op, row, 'user_id'),
    side: positionSide(op, row.side),
    result,
    points_delta: pointsDelta,
    display_name: stringField(op, user, 'display_name'),
    username: nullableStringField(op, user, 'username'),
  };
}

type StatsIdentity = {
  readonly op: string;
  readonly groupId: number;
  readonly userId: number;
};

function parseStatsRecord(row: DatabaseRow, identity: StatsIdentity): GroupPlayerStats {
  const returnedGroupId = safeIntegerField(identity.op, row, 'group_id');
  const returnedUserId = positiveIntegerField(identity.op, row, 'user_id');
  if (returnedGroupId !== identity.groupId) return contractFailure(identity.op, 'group_id');
  if (returnedUserId !== identity.userId) return contractFailure(identity.op, 'user_id');
  const points = countField(identity.op, row, 'points');
  const wins = countField(identity.op, row, 'wins');
  const losses = countField(identity.op, row, 'losses');
  const currentStreak = countField(identity.op, row, 'current_streak');
  const bestStreak = countField(identity.op, row, 'best_streak');
  const expectedPoints = wins * 10;
  if (!Number.isSafeInteger(expectedPoints) || points !== expectedPoints) {
    return contractFailure(identity.op, 'points');
  }
  if (currentStreak > bestStreak || bestStreak > wins) {
    return contractFailure(identity.op, 'best_streak');
  }
  const decisions = wins + losses;
  if (!Number.isSafeInteger(decisions)) return contractFailure(identity.op, 'accuracy');
  return {
    group_id: returnedGroupId,
    user_id: returnedUserId,
    points,
    wins,
    losses,
    accuracy: decisions === 0 ? 0 : wins / decisions,
    current_streak: currentStreak,
    best_streak: bestStreak,
  };
}

function parseLeaderboardEntry(value: unknown, groupId: number): LeaderboardEntry {
  const op = GROUP_POINTS_QUERY_OPS.leaderboard;
  const row = record(op, value);
  const userId = positiveIntegerField(op, row, 'user_id');
  const stats = parseStatsRecord(row, { op, groupId, userId });
  const user = record(op, row.user);
  return {
    ...stats,
    display_name: stringField(op, user, 'display_name'),
    username: nullableStringField(op, user, 'username'),
  };
}

function isLeaderboardOutOfOrder(
  previous: LeaderboardEntry,
  current: LeaderboardEntry,
): boolean {
  if (previous.points !== current.points) return previous.points < current.points;
  if (previous.wins !== current.wins) return previous.wins < current.wins;
  if (previous.losses !== current.losses) return previous.losses > current.losses;
  return previous.user_id > current.user_id;
}

type OrderedParticipant = {
  readonly participant: PositionParticipant;
  readonly placedAtMs: number;
};

function parseParticipant(value: unknown, marketId: string): OrderedParticipant {
  const op = GROUP_POINTS_QUERY_OPS.participants;
  const row = record(op, value);
  const returnedMarketId = stringField(op, row, 'market_id');
  const market = record(op, row.market);
  const joinedMarketId = stringField(op, market, 'id');
  if (returnedMarketId !== marketId || joinedMarketId !== marketId) {
    return contractFailure(op, 'market_id');
  }
  const user = record(op, row.user);
  return {
    placedAtMs: countField(op, row, 'placed_at_ms'),
    participant: {
      group_id: safeIntegerField(op, market, 'group_id'),
      market_id: returnedMarketId,
      user_id: positiveIntegerField(op, row, 'user_id'),
      side: positionSide(op, row.side),
      display_name: stringField(op, user, 'display_name'),
      username: nullableStringField(op, user, 'username'),
    },
  };
}

function compareParticipants(left: OrderedParticipant, right: OrderedParticipant): number {
  if (left.placedAtMs !== right.placedAtMs) return left.placedAtMs - right.placedAtMs;
  if (left.participant.user_id !== right.participant.user_id) {
    return left.participant.user_id - right.participant.user_id;
  }
  return left.participant.side.localeCompare(right.participant.side);
}

function pointResult(value: unknown): 'won' | 'lost' {
  switch (value) {
    case 'won':
    case 'lost':
      return value;
    default:
      return contractFailure(GROUP_POINTS_QUERY_OPS.pointResults, 'result');
  }
}

function pointDelta(value: unknown): 10 | 0 {
  switch (value) {
    case 10:
    case 0:
      return value;
    default:
      return contractFailure(GROUP_POINTS_QUERY_OPS.pointResults, 'points_delta');
  }
}
