import { describe, expect, it } from 'vitest';
import { GroupPointsApplicationError } from './service.js';
import {
  FAILURE_CASES,
  GROUP_ID,
  MARKET_ID,
  RESULTS,
  boundedResults,
  eligibleDb,
  serviceHarness,
} from './service.test-support.js';
import type { PointsDb } from './service.test-support.js';

describe('group points application service', () => {
  it('applies an eligible market and maps its results and top five', async () => {
    // Given an atomic first apply followed by persisted point projections
    const calls: string[] = [];
    const harness = serviceHarness(eligibleDb(calls));

    // When the market is applied
    const summary = await harness.service.apply(MARKET_ID);

    // Then persisted rows are mapped without exposing database identities
    expect(calls).toEqual([
      `apply:${MARKET_ID}`,
      `results:${MARKET_ID}`,
      `leaderboard:${GROUP_ID}:5`,
    ]);
    expect(summary).toEqual({
      eligible: true,
      duplicate: false,
      marketId: MARKET_ID,
      groupId: GROUP_ID,
      scoredCount: 2,
      winnerCount: 1,
      winners: [{ displayName: 'Alice', username: 'alice_calls' }],
      misses: [{ displayName: 'Bob', username: null }],
      leaderboard: [
        { displayName: 'Alice', username: 'alice_calls', points: 20, wins: 2, losses: 0 },
        { displayName: 'Bob', username: null, points: 0, wins: 0, losses: 1 },
      ],
    });
    expect(harness.logs).toEqual([
      {
        event: 'group_points_applied',
        fields: {
          marketId: MARKET_ID,
          scoredCount: 2,
          winnerCount: 1,
        },
      },
    ]);
  });

  it('accepts bounded result labels while retaining authoritative overflow counts', async () => {
    // Given the apply RPC reports more winners and misses than the label projection exposes
    const results = boundedResults(10, 10);
    const harness = serviceHarness(eligibleDb([], {
      applyGroupPoints: async () => ({
        ok: true,
        eligible: true,
        duplicate: false,
        reason: null,
        group_id: GROUP_ID,
        scored_count: 37,
        winner_count: 15,
      }),
      pointResultsForMarket: async () => results,
      leaderboard: async () => [],
    }));

    // When the bounded receipt projection is consumed
    const summary = await harness.service.apply(MARKET_ID);

    // Then exact totals remain available while only ten labels per outcome are returned
    expect(summary).toEqual({
      eligible: true,
      duplicate: false,
      marketId: MARKET_ID,
      groupId: GROUP_ID,
      scoredCount: 37,
      winnerCount: 15,
      winners: Array.from({ length: 10 }, (_, index) => ({
        displayName: `Winner ${index + 1}`,
        username: null,
      })),
      misses: Array.from({ length: 10 }, (_, index) => ({
        displayName: `Miss ${index + 1}`,
        username: null,
      })),
      leaderboard: [],
    });
  });

  it.each(
    ['pre_activation', 'replay', 'unsupported_market'] satisfies readonly (
      'pre_activation' | 'replay' | 'unsupported_market'
    )[],
  )(
    'returns an explicit %s summary without reading identities',
    async (reason) => {
      // Given an atomic result that excludes this market from group points
      let identityReads = 0;
      const harness = serviceHarness(eligibleDb([], {
        applyGroupPoints: async () => ({
          ok: true,
          eligible: false,
          duplicate: false,
          reason,
          group_id: GROUP_ID,
          scored_count: 0,
          winner_count: 0,
        }),
        pointResultsForMarket: async () => {
          identityReads += 1;
          return [];
        },
        leaderboard: async () => {
          identityReads += 1;
          return [];
        },
      }));

      // When the excluded market is applied
      const summary = await harness.service.apply(MARKET_ID);

      // Then no participant projection is touched or logged
      expect(summary).toEqual({
        eligible: false,
        duplicate: false,
        marketId: MARKET_ID,
        groupId: GROUP_ID,
        reason,
      });
      expect(identityReads).toBe(0);
      expect(harness.logs).toEqual([{
        event: 'group_points_ineligible',
        fields: { marketId: MARKET_ID, scoredCount: 0, winnerCount: 0 },
      }]);
    },
  );

  it('retries the atomic apply after a result-read failure and converges as duplicate', async () => {
    // Given the first RPC commits but its following projection read fails
    let applies = 0;
    const db = eligibleDb([], {
      applyGroupPoints: async () => {
        applies += 1;
        return {
          ok: true,
          eligible: true,
          duplicate: applies > 1,
          reason: null,
          group_id: GROUP_ID,
          scored_count: 2,
          winner_count: 1,
        };
      },
      pointResultsForMarket: async () => {
        if (applies === 1) throw new Error('private player read detail');
        return RESULTS;
      },
    });
    const harness = serviceHarness(db);

    // When delivery preparation is interrupted and retried
    await expect(harness.service.apply(MARKET_ID)).rejects.toBeInstanceOf(
      GroupPointsApplicationError,
    );
    const retry = await harness.service.apply(MARKET_ID);

    // Then the idempotent RPC is called again and no private failure detail is logged
    expect(applies).toBe(2);
    expect(retry).toMatchObject({
      eligible: true,
      duplicate: true,
      winners: [{ displayName: 'Alice', username: 'alice_calls' }],
      misses: [{ displayName: 'Bob', username: null }],
    });
    expect(harness.logs).toEqual([
      {
        event: 'group_points_failed',
        fields: { marketId: MARKET_ID, scoredCount: 2, winnerCount: 1 },
      },
      {
        event: 'group_points_duplicate',
        fields: { marketId: MARKET_ID, scoredCount: 2, winnerCount: 1 },
      },
    ]);
    expect(JSON.stringify(harness.logs)).not.toContain('private player read detail');
    expect(JSON.stringify(harness.logs)).not.toContain(String(GROUP_ID));
  });

  it('returns an eligible empty summary for a void or participant-free market', async () => {
    // Given an eligible marker with no point events or existing leaderboard rows
    const harness = serviceHarness(eligibleDb([], {
      applyGroupPoints: async () => ({
        ok: true, eligible: true, duplicate: false, reason: null,
        group_id: GROUP_ID, scored_count: 0, winner_count: 0,
      }),
      pointResultsForMarket: async () => [],
      leaderboard: async () => [],
    }));

    // When its persisted projections are loaded
    const summary = await harness.service.apply(MARKET_ID);

    // Then no participant or score is synthesized in TypeScript
    expect(summary).toMatchObject({
      eligible: true, scoredCount: 0, winnerCount: 0,
      winners: [], misses: [], leaderboard: [],
    });
  });

  it.each(FAILURE_CASES)('throws and redacts logs for %s', async (_label, overrides) => {
    // Given a rejected or identity-inconsistent database projection
    const harness = serviceHarness(eligibleDb([], overrides));

    // When the service applies the market
    const action = harness.service.apply(MARKET_ID);

    // Then receipt preparation remains retryable and logs no participant identity
    await expect(action).rejects.toBeInstanceOf(GroupPointsApplicationError);
    expect(harness.logs).toHaveLength(1);
    expect(harness.logs[0]?.event).toBe('group_points_failed');
    expect(JSON.stringify(harness.logs)).not.toMatch(/Alice|Bob|alice_calls|groupId|userId|username/);
    expect(JSON.stringify(harness.logs)).not.toContain(String(GROUP_ID));
  });
});
