import type { EngineDb } from '../ports.js';
import { createGroupPointsService } from './service.js';

export const MARKET_ID = '60000000-0000-4000-8000-000000000001';
export const GROUP_ID = -100_600;

export type PointsDb = Pick<
  EngineDb,
  'applyGroupPoints' | 'pointResultsForMarket' | 'leaderboard'
>;
export type PointResult = Awaited<ReturnType<PointsDb['pointResultsForMarket']>>[number];
type LeaderboardEntry = Awaited<ReturnType<PointsDb['leaderboard']>>[number];
type CapturedLog = {
  readonly event: string;
  readonly fields?: Record<string, unknown>;
};

const WINNER = {
  group_id: GROUP_ID, market_id: MARKET_ID, user_id: 6001, side: 'back',
  result: 'won', points_delta: 10, display_name: 'Alice', username: 'alice_calls',
} satisfies PointResult;

const MISS = {
  group_id: GROUP_ID, market_id: MARKET_ID, user_id: 6002, side: 'doubt',
  result: 'lost', points_delta: 0, display_name: 'Bob', username: null,
} satisfies PointResult;

export const RESULTS = [WINNER, MISS] satisfies readonly PointResult[];

const LEADER = {
  group_id: GROUP_ID, user_id: 6001, display_name: 'Alice', username: 'alice_calls',
  points: 20, wins: 2, losses: 0, accuracy: 1, current_streak: 2, best_streak: 2,
} satisfies LeaderboardEntry;

const BOARD = [
  LEADER,
  {
    group_id: GROUP_ID, user_id: 6002, display_name: 'Bob', username: null,
    points: 0, wins: 0, losses: 1, accuracy: 0, current_streak: 0, best_streak: 0,
  },
] satisfies readonly LeaderboardEntry[];

export function boundedResults(winners: number, misses: number): readonly PointResult[] {
  return [
    ...Array.from({ length: winners }, (_, index): PointResult => ({
      ...WINNER,
      user_id: 6100 + index,
      display_name: `Winner ${index + 1}`,
      username: null,
    })),
    ...Array.from({ length: misses }, (_, index): PointResult => ({
      ...MISS,
      user_id: 6200 + index,
      display_name: `Miss ${index + 1}`,
    })),
  ];
}

export function eligibleDb(calls: string[], overrides: Partial<PointsDb> = {}): PointsDb {
  return {
    applyGroupPoints: async (marketId) => {
      calls.push(`apply:${marketId}`);
      return {
        ok: true,
        eligible: true,
        duplicate: false,
        reason: null,
        group_id: GROUP_ID,
        scored_count: RESULTS.length,
        winner_count: 1,
      };
    },
    pointResultsForMarket: async (marketId) => {
      calls.push(`results:${marketId}`);
      return RESULTS;
    },
    leaderboard: async (groupId, limit) => {
      calls.push(`leaderboard:${groupId}:${limit}`);
      return BOARD;
    },
    ...overrides,
  };
}

export function serviceHarness(db: PointsDb): {
  readonly service: ReturnType<typeof createGroupPointsService>;
  readonly logs: CapturedLog[];
} {
  const logs: CapturedLog[] = [];
  return {
    service: createGroupPointsService({
      db,
      log: {
        info: (event, fields) => logs.push({ event, fields }),
        error: (event, fields) => logs.push({ event, fields }),
      },
    }),
    logs,
  };
}

function malformedResult(field: 'display_name' | 'result' | 'points_delta', value: unknown) {
  const row: PointResult = { ...WINNER };
  Reflect.set(row, field, value);
  return [row, MISS];
}

function malformedLeaderboard(): readonly LeaderboardEntry[] {
  const row: LeaderboardEntry = { ...LEADER };
  Reflect.set(row, 'display_name', { private: 'Alice' });
  return [row];
}

export const FAILURE_CASES = [
  ['RPC rejection', {
    applyGroupPoints: async () => ({ ok: false, code: 'settlement_missing' }),
  }],
  ['cross-group result', {
    pointResultsForMarket: async () => RESULTS.map((row) => ({ ...row, group_id: GROUP_ID - 1 })),
  }],
  ['cross-group leaderboard', {
    leaderboard: async () => BOARD.map((row) => ({ ...row, group_id: GROUP_ID - 1 })),
  }],
  ['short bounded projection', {
    applyGroupPoints: async () => ({
      ok: true, eligible: true, duplicate: true, reason: null,
      group_id: GROUP_ID, scored_count: 3, winner_count: 1,
    }),
  }],
  ['oversized leaderboard', {
    leaderboard: async () => [...BOARD, ...BOARD, ...BOARD],
  }],
  ['malformed projection row', {
    pointResultsForMarket: async () => malformedResult('display_name', { private: 'Alice' }),
  }],
  ['malformed result value', {
    pointResultsForMarket: async () => malformedResult('result', 'draw'),
  }],
  ['result and points mismatch', {
    pointResultsForMarket: async () => malformedResult('points_delta', 0),
  }],
  ['malformed leaderboard row', {
    leaderboard: async () => malformedLeaderboard(),
  }],
  ['wrong-market projection row', {
    pointResultsForMarket: async () =>
      RESULTS.map((row) => ({ ...row, market_id: `${MARKET_ID}-wrong` })),
  }],
] satisfies ReadonlyArray<readonly [string, Partial<PointsDb>]>;
