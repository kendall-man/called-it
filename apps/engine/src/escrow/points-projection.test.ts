import { describe, expect, it } from 'vitest';
import type { GroupPointsService, GroupPointsSummary } from '../points/service.js';
import {
  createEscrowFinalizedPointsProjection,
  createEscrowPrivatePointsParticipants,
} from './points-projection.js';

const MARKET_ID = '123e4567-e89b-12d3-a456-426614174000';
const appliedSummary: GroupPointsSummary = {
  eligible: true, duplicate: false, marketId: MARKET_ID, groupId: -1001,
  scoredCount: 1, winnerCount: 1,
  winners: [{ displayName: 'Alice', username: 'alice' }], misses: [], leaderboard: [],
};

function setup(replay: boolean) {
  let applied = false;
  let pointMutations = 0;
  let privateReads = 0;
  const points: GroupPointsService = {
    async apply() {
      pointMutations += applied ? 0 : 1;
      const duplicate = applied;
      applied = true;
      return { ...appliedSummary, duplicate };
    },
  };
  const projection = createEscrowFinalizedPointsProjection({
    points,
    privateParticipants: {
      async prepare() {
        privateReads += 1;
        return { custodyMode: 'escrow', replay };
      },
    },
  });
  return { projection, points, pointMutations: () => pointMutations, privateReads: () => privateReads };
}

const economicEvent = {
  marketId: MARKET_ID, kind: 'settlement' as const, signature: 'signature-a', instructionIndex: 0,
};

describe('finalized escrow Points projection', () => {
  it('uses the existing idempotent Points service across duplicate delivery and restart', async () => {
    const fixture = setup(false);

    const first = await fixture.projection.afterEconomicProjection(economicEvent);
    const restarted = createEscrowFinalizedPointsProjection({
      points: fixture.points,
      privateParticipants: { async prepare() { return { custodyMode: 'escrow', replay: false }; } },
    });
    const duplicate = await restarted.afterEconomicProjection({ ...economicEvent, kind: 'claim' });

    expect(first).toMatchObject({ kind: 'applied', summary: { duplicate: false } });
    expect(duplicate).toMatchObject({ kind: 'applied', summary: { duplicate: true } });
    expect(fixture.pointMutations()).toBe(1);
  });

  it('never invokes Points for replay escrow markets', async () => {
    const fixture = setup(true);

    await expect(fixture.projection.afterEconomicProjection(economicEvent))
      .resolves.toEqual({ kind: 'replay_skipped' });
    expect(fixture.pointMutations()).toBe(0);
    expect(fixture.privateReads()).toBe(1);
  });

  it('uses immutable custody after a group is removed from the intake rollout', async () => {
    const points = setup(false);
    const participants = createEscrowPrivatePointsParticipants({
      markets: {
        async getMarket() {
          return { custody_mode: 'escrow', is_replay: false };
        },
      },
    });
    const projection = createEscrowFinalizedPointsProjection({
      privateParticipants: participants,
      points: points.points,
    });

    await expect(projection.afterEconomicProjection(economicEvent))
      .resolves.toMatchObject({ kind: 'applied', summary: { duplicate: false } });
    expect(points.pointMutations()).toBe(1);
  });

  it('preserves legacy parity by delegating escrow awards to the same Points service', async () => {
    const fixture = setup(false);
    const legacy = await fixture.points.apply(MARKET_ID);
    const escrow = await fixture.projection.afterEconomicProjection(economicEvent);

    expect(legacy).toMatchObject({ eligible: true, winnerCount: 1 });
    expect(escrow).toMatchObject({ kind: 'applied', summary: { eligible: true, winnerCount: 1 } });
    expect(fixture.pointMutations()).toBe(1);
  });
});
