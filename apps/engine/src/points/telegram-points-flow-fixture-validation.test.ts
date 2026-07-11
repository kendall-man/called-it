import { describe, expect, it } from 'vitest';
import { TelegramPointsFlowHarness } from './telegram-points-flow.test-support.js';
import {
  ALICE_ID,
  BOB_ID,
  CALLER_ID,
  GROUP_TWO_ID,
  pointTransition,
} from './telegram-points-flow-fixtures.test-support.js';
import {
  PointFixtureMismatch,
  type PointTransition,
} from './telegram-points-flow-source-validator.test-support.js';

type Mutation =
  | 'caller_without_tap'
  | 'wrong_group'
  | 'wrong_side'
  | 'wrong_outcome'
  | 'duplicate_event';

function mutateTransition(
  mutation: Mutation,
  transition: PointTransition,
): PointTransition {
  switch (mutation) {
    case 'caller_without_tap':
      return {
        ...transition,
        results: transition.results.map((result) =>
          result.user_id === ALICE_ID ? { ...result, user_id: CALLER_ID } : result,
        ),
      };
    case 'wrong_group':
      return { ...transition, source: { ...transition.source, groupId: GROUP_TWO_ID } };
    case 'wrong_side':
      return {
        ...transition,
        source: {
          ...transition.source,
          taps: transition.source.taps.map((tap) =>
            tap.userId === ALICE_ID ? { ...tap, side: 'doubt' } : tap,
          ),
        },
      };
    case 'wrong_outcome':
      return { ...transition, source: { ...transition.source, outcome: 'claim_lost' } };
    case 'duplicate_event':
      return {
        ...transition,
        results: [
          ...transition.results,
          ...transition.results.filter((result) => result.user_id === ALICE_ID),
        ],
      };
    default:
      return assertNever(mutation);
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported fixture mutation: ${value}`);
}

describe('Telegram point fixture source validation', () => {
  it.each<Mutation>([
    'caller_without_tap',
    'wrong_group',
    'wrong_side',
    'wrong_outcome',
    'duplicate_event',
  ])('rejects %s before installing persisted scoring rows', async (mutation) => {
    // Given an actual terminal market whose external source snapshot is mutated
    const harness = new TelegramPointsFlowHarness();
    const market = await harness.createCall(0);
    await harness.tap(market, ALICE_ID, 'back');
    await harness.tap(market, BOB_ID, 'doubt');
    const configured = pointTransition('group_one_win', market.id);
    harness.runtime.db.setPointTransition(market.id, mutateTransition(mutation, configured));

    // When the real settlement path attempts the atomic scoring apply
    await harness.settle(market, 'claim_won');

    // Then validation rejects before marker, event, or stat mutation
    expect(harness.runtime.db.persistedScoringBytes(market.id)).toBe(
      '{"marker":null,"events":[],"stats":[]}',
    );
    await expect(harness.runtime.points.apply(market.id)).rejects.toMatchObject({
      name: 'GroupPointsApplicationError',
      failure: 'dependency_failure',
      cause: expect.any(PointFixtureMismatch),
    });
    expect(harness.runtime.db.applyCount(market.id)).toBe(2);
    expect(harness.runtime.db.persistedScoringBytes(market.id)).toBe(
      '{"marker":null,"events":[],"stats":[]}',
    );
  });

  it('rejects duplicate fixture configuration without replacing the source snapshot', async () => {
    // Given a market with one configured external transition
    const harness = new TelegramPointsFlowHarness();
    const market = await harness.createCall(0);
    const configured = pointTransition('group_one_win', market.id);
    harness.runtime.db.setPointTransition(market.id, configured);

    // When a second fixture mutation targets the same market
    const duplicate = () => harness.runtime.db.setPointTransition(market.id, {
      ...configured,
      source: { ...configured.source, outcome: 'claim_lost' },
    });

    // Then the duplicate is rejected before persisted scoring state exists
    expect(duplicate).toThrow(PointFixtureMismatch);
    expect(harness.runtime.db.persistedScoringBytes(market.id)).toBe(
      '{"marker":null,"events":[],"stats":[]}',
    );
  });
});
