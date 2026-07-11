import type { EngineDb } from '../ports.js';

export type PointMethodStubs = Pick<
  EngineDb,
  | 'applyGroupPoints'
  | 'pointResultsForMarket'
  | 'groupPlayerStats'
  | 'leaderboard'
  | 'positionParticipantsForMarket'
>;

type PointMethodStubBehavior =
  | { readonly kind: 'empty'; readonly groupId: number }
  | { readonly kind: 'unreachable'; readonly call: () => Promise<never> };

export function createPointMethodStubs(
  behavior: PointMethodStubBehavior,
): PointMethodStubs {
  switch (behavior.kind) {
    case 'empty':
      return {
        applyGroupPoints: async () => ({
          ok: true,
          eligible: false,
          duplicate: false,
          reason: 'pre_activation',
          group_id: behavior.groupId,
          scored_count: 0,
          winner_count: 0,
        }),
        pointResultsForMarket: async () => [],
        groupPlayerStats: async (groupId, userId) => ({
          group_id: groupId,
          user_id: userId,
          points: 0,
          wins: 0,
          losses: 0,
          accuracy: 0,
          current_streak: 0,
          best_streak: 0,
        }),
        leaderboard: async () => [],
        positionParticipantsForMarket: async () => [],
      };
    case 'unreachable':
      return {
        applyGroupPoints: behavior.call,
        pointResultsForMarket: behavior.call,
        groupPlayerStats: behavior.call,
        leaderboard: behavior.call,
        positionParticipantsForMarket: behavior.call,
      };
    default:
      return assertNever(behavior);
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported point stub behavior: ${JSON.stringify(value)}`);
}
