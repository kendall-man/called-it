import { describe, expect, it } from 'vitest';
import { createPointMethodStubs } from './point-methods.test-support.js';

const GROUP_ID = -100321;
const USER_ID = 701;

describe('createPointMethodStubs', () => {
  it('returns the existing inert point responses in empty mode', async () => {
    // Given an EngineDb point-method set configured for an inert test harness
    const methods = createPointMethodStubs({ kind: 'empty', groupId: GROUP_ID });

    // When every point method is called
    const [applied, results, stats, leaders, participants] = await Promise.all([
      methods.applyGroupPoints('market-1'),
      methods.pointResultsForMarket('market-1'),
      methods.groupPlayerStats(GROUP_ID, USER_ID),
      methods.leaderboard(GROUP_ID, 10),
      methods.positionParticipantsForMarket('market-1'),
    ]);

    // Then the helper reproduces the prior empty fixture behavior
    expect(applied).toEqual({
      ok: true,
      eligible: false,
      duplicate: false,
      reason: 'pre_activation',
      group_id: GROUP_ID,
      scored_count: 0,
      winner_count: 0,
    });
    expect(results).toEqual([]);
    expect(stats).toEqual({
      group_id: GROUP_ID,
      user_id: USER_ID,
      points: 0,
      wins: 0,
      losses: 0,
      accuracy: 0,
      current_streak: 0,
      best_streak: 0,
    });
    expect(leaders).toEqual([]);
    expect(participants).toEqual([]);
  });

  it('delegates every point method to the existing failure stub in unreachable mode', async () => {
    // Given the failure callback used by strict test harnesses
    const error = new Error('unexpected test dependency call');
    const unreachable = async (): Promise<never> => {
      throw error;
    };
    const methods = createPointMethodStubs({ kind: 'unreachable', call: unreachable });

    // When every point method is called
    const outcomes = await Promise.allSettled([
      methods.applyGroupPoints('market-1'),
      methods.pointResultsForMarket('market-1'),
      methods.groupPlayerStats(GROUP_ID, USER_ID),
      methods.leaderboard(GROUP_ID, 10),
      methods.positionParticipantsForMarket('market-1'),
    ]);

    // Then all calls retain the exact delegated failure
    expect(outcomes).toEqual(Array.from(
      { length: 5 },
      () => ({ status: 'rejected', reason: error }),
    ));
  });
});
