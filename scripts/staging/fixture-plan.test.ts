import assert from 'node:assert/strict';
import test from 'node:test';

import {
  StagingFixturePlanError,
  createStagingCleanupPlan,
  createStagingSeedPlan,
  executeStagingFixturePlan,
  type FixturePlanAction,
} from './fixture-plan.js';

test('creates a deterministic tagged staging seed plan without executing it', () => {
  // Given tagged synthetic fixtures in non-deterministic order
  const input = fixtureRequest([
    fixture('stg_fixture_b'),
    fixture('stg_fixture_a'),
  ]);

  // When a staging seed plan is requested
  const plan = createStagingSeedPlan(input);

  // Then it only describes sorted staging upserts
  assert.deepEqual(plan.actions.map((action) => action.fixture_id), ['stg_fixture_a', 'stg_fixture_b']);
  assert.deepEqual(plan.actions.map((action) => action.operation), [
    'upsert_tagged_synthetic_fixture',
    'upsert_tagged_synthetic_fixture',
  ]);
});

test('refuses a seed plan that is not explicitly staging', () => {
  // Given a request pointed at production
  const input = fixtureRequest([fixture('stg_fixture_a')]);
  input.target = 'production';

  // When the seed planner receives it
  // Then it fails before it can describe an unsafe action
  assert.throws(() => createStagingSeedPlan(input), StagingFixturePlanError);
});

test('refuses cleanup of untagged or non-synthetic data', () => {
  // Given a candidate whose tag is missing and synthetic marker is false
  const input = fixtureRequest([fixture('stg_fixture_a')]);
  const candidate = input.fixtures[0];
  if (candidate === undefined) throw new Error('fixture setup failed');
  candidate.tag = 'untagged';
  candidate.synthetic = false;

  // When cleanup is planned
  // Then it refuses instead of emitting a delete action
  assert.throws(
    () => createStagingCleanupPlan(input),
    (error: unknown) => error instanceof StagingFixturePlanError && /(calledit:staging|synthetic)/u.test(error.message),
  );
});

test('refuses cleanup of a fixture observed outside staging', () => {
  // Given a tagged synthetic fixture whose observed target is production
  const input = fixtureRequest([fixture('stg_fixture_a')]);
  const candidate = input.fixtures[0];
  if (candidate === undefined) throw new Error('fixture setup failed');
  candidate.target = 'production';

  // When cleanup is planned
  // Then it never creates a production delete plan
  assert.throws(
    () => createStagingCleanupPlan(input),
    (error: unknown) => error instanceof StagingFixturePlanError && /non-staging deletion/u.test(error.message),
  );
});

test('executes only through an explicitly staging adapter', async () => {
  // Given a valid cleanup plan and a configured staging adapter
  const plan = createStagingCleanupPlan(fixtureRequest([fixture('stg_fixture_a')]));
  const actions: FixturePlanAction[] = [];
  const adapter = {
    target: 'staging' as const,
    execute: async (action: FixturePlanAction): Promise<void> => {
      actions.push(action);
    },
  };

  // When the caller explicitly passes that adapter to the executor
  await executeStagingFixturePlan(plan, adapter);

  // Then the adapter receives only the tagged staging deletion action
  assert.deepEqual(actions, plan.actions);
  assert.equal(actions[0]?.operation, 'delete_tagged_synthetic_fixture');
});

function fixtureRequest(fixtures: Array<ReturnType<typeof fixture>>) {
  return {
    target: 'staging',
    tag: 'calledit:staging:release-001',
    fixtures,
  };
}

function fixture(fixtureId: string) {
  return {
    fixture_id: fixtureId,
    target: 'staging',
    tag: 'calledit:staging:release-001',
    synthetic: true,
  };
}
