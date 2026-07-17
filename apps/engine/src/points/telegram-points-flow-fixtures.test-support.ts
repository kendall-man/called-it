import type { FixtureRow, GroupRow, UserRow } from '../ports.js';
import type { LeaderboardEntry, PointResult } from '../ports/rows.js';
import type { PointTransition } from './telegram-points-flow-source-validator.test-support.js';

export const NOW_MS = Date.parse('2026-07-12T12:00:00.000Z');
export const GROUP_ONE_ID = -100_910_001;
export const GROUP_TWO_ID = -100_910_002;
export const CALLER_ID = 91_000;
export const ALICE_ID = 91_001;
export const BOB_ID = 91_002;
export const CARA_ID = 91_003;

export const GROUPS: readonly GroupRow[] = [
  { id: GROUP_ONE_ID, title: 'North Stand', slug: 'north-stand', web_enabled: true, chattiness: 'react_only', is_admin: true },
  { id: GROUP_TWO_ID, title: 'Away End', slug: 'away-end', web_enabled: true, chattiness: 'react_only', is_admin: true },
];

export const USERS: readonly UserRow[] = [
  { id: CALLER_ID, display_name: 'Dee Caller', username: 'dee_calls' },
  { id: ALICE_ID, display_name: 'Alice', username: 'alice_calls' },
  { id: BOB_ID, display_name: 'Bob', username: null },
  { id: CARA_ID, display_name: 'Cara', username: 'cara_calls' },
];

export const CALL_FIXTURES = [
  { fixtureId: 5_101, groupId: GROUP_ONE_ID, text: 'Atlas will win the opener', team: 'Atlas FC', opponent: 'Beacon FC' },
  { fixtureId: 5_102, groupId: GROUP_ONE_ID, text: 'Boreal will win the late game', team: 'Boreal FC', opponent: 'Cedar FC' },
  { fixtureId: 5_103, groupId: GROUP_TWO_ID, text: 'Cygnus will win tonight', team: 'Cygnus FC', opponent: 'Delta FC' },
] as const;

export type PointFixtureKind = 'group_one_win' | 'group_one_loss' | 'group_two_win';

export function fixtureRows(): readonly FixtureRow[] {
  return CALL_FIXTURES.map((fixture) => ({
    fixture_id: fixture.fixtureId,
    p1_name: fixture.team,
    p2_name: fixture.opponent,
    kickoff_at: new Date(NOW_MS + 60 * 60_000).toISOString(),
    phase: 'NS',
    minute: null,
    last_seq: 0,
    score: {},
    coverage_unreliable: false,
  }));
}

function applyResult(groupId: number, duplicate: boolean) {
  return {
    ok: true,
    eligible: true,
    duplicate,
    reason: null,
    group_id: groupId,
    scored_count: 2,
    winner_count: 1,
  } as const;
}

function transition(
  source: PointTransition['source'],
  results: readonly PointResult[],
  stats: PointTransition['stats'],
  leaderboard: readonly LeaderboardEntry[],
): PointTransition {
  return {
    source,
    first: applyResult(source.groupId, false),
    retry: applyResult(source.groupId, true),
    results,
    stats,
    leaderboard,
  };
}

export function pointTransition(kind: PointFixtureKind, marketId: string): PointTransition {
  switch (kind) {
    case 'group_one_win':
      return transition(
        {
          groupId: GROUP_ONE_ID,
          outcome: 'claim_won',
          taps: [
            { userId: ALICE_ID, side: 'back' },
            { userId: BOB_ID, side: 'doubt' },
          ],
        },
        [
          { group_id: GROUP_ONE_ID, market_id: marketId, user_id: ALICE_ID, side: 'back', result: 'won', points_delta: 10, display_name: 'Alice', username: 'alice_calls' },
          { group_id: GROUP_ONE_ID, market_id: marketId, user_id: BOB_ID, side: 'doubt', result: 'lost', points_delta: 0, display_name: 'Bob', username: null },
        ],
        [
          { group_id: GROUP_ONE_ID, user_id: ALICE_ID, points: 10, wins: 1, losses: 0, accuracy: 1, current_streak: 1, best_streak: 1 },
          { group_id: GROUP_ONE_ID, user_id: BOB_ID, points: 0, wins: 0, losses: 1, accuracy: 0, current_streak: 0, best_streak: 0 },
        ],
        [
          { group_id: GROUP_ONE_ID, user_id: ALICE_ID, display_name: 'Alice', username: 'alice_calls', points: 10, wins: 1, losses: 0, accuracy: 1, current_streak: 1, best_streak: 1 },
          { group_id: GROUP_ONE_ID, user_id: BOB_ID, display_name: 'Bob', username: null, points: 0, wins: 0, losses: 1, accuracy: 0, current_streak: 0, best_streak: 0 },
        ],
      );
    case 'group_one_loss':
      return transition(
        {
          groupId: GROUP_ONE_ID,
          outcome: 'claim_lost',
          taps: [
            { userId: ALICE_ID, side: 'back' },
            { userId: BOB_ID, side: 'doubt' },
          ],
        },
        [
          { group_id: GROUP_ONE_ID, market_id: marketId, user_id: ALICE_ID, side: 'back', result: 'lost', points_delta: 0, display_name: 'Alice', username: 'alice_calls' },
          { group_id: GROUP_ONE_ID, market_id: marketId, user_id: BOB_ID, side: 'doubt', result: 'won', points_delta: 10, display_name: 'Bob', username: null },
        ],
        [
          { group_id: GROUP_ONE_ID, user_id: ALICE_ID, points: 10, wins: 1, losses: 1, accuracy: 0.5, current_streak: 0, best_streak: 1 },
          { group_id: GROUP_ONE_ID, user_id: BOB_ID, points: 10, wins: 1, losses: 1, accuracy: 0.5, current_streak: 1, best_streak: 1 },
        ],
        [
          { group_id: GROUP_ONE_ID, user_id: ALICE_ID, display_name: 'Alice', username: 'alice_calls', points: 10, wins: 1, losses: 1, accuracy: 0.5, current_streak: 0, best_streak: 1 },
          { group_id: GROUP_ONE_ID, user_id: BOB_ID, display_name: 'Bob', username: null, points: 10, wins: 1, losses: 1, accuracy: 0.5, current_streak: 1, best_streak: 1 },
        ],
      );
    case 'group_two_win':
      return transition(
        {
          groupId: GROUP_TWO_ID,
          outcome: 'claim_won',
          taps: [
            { userId: ALICE_ID, side: 'back' },
            { userId: CARA_ID, side: 'doubt' },
          ],
        },
        [
          { group_id: GROUP_TWO_ID, market_id: marketId, user_id: ALICE_ID, side: 'back', result: 'won', points_delta: 10, display_name: 'Alice', username: 'alice_calls' },
          { group_id: GROUP_TWO_ID, market_id: marketId, user_id: CARA_ID, side: 'doubt', result: 'lost', points_delta: 0, display_name: 'Cara', username: 'cara_calls' },
        ],
        [
          { group_id: GROUP_TWO_ID, user_id: ALICE_ID, points: 10, wins: 1, losses: 0, accuracy: 1, current_streak: 1, best_streak: 1 },
          { group_id: GROUP_TWO_ID, user_id: CARA_ID, points: 0, wins: 0, losses: 1, accuracy: 0, current_streak: 0, best_streak: 0 },
        ],
        [
          { group_id: GROUP_TWO_ID, user_id: ALICE_ID, display_name: 'Alice', username: 'alice_calls', points: 10, wins: 1, losses: 0, accuracy: 1, current_streak: 1, best_streak: 1 },
          { group_id: GROUP_TWO_ID, user_id: CARA_ID, display_name: 'Cara', username: 'cara_calls', points: 0, wins: 0, losses: 1, accuracy: 0, current_streak: 0, best_streak: 0 },
        ],
      );
    default:
      return assertNever(kind);
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported point fixture: ${value}`);
}
