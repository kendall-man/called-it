export const STAGING_FIXTURE_PLAN_SCHEMA_VERSION = 1;
export const STAGING_FIXTURE_TAG_PREFIX = 'calledit:staging:';

const FIXTURE_ID = /^stg_[a-z0-9][a-z0-9_-]{2,95}$/u;
const RUN_ID = /^[a-z0-9][a-z0-9_-]{2,95}$/u;

export type FixturePlanMode = 'seed' | 'cleanup';

export type TaggedSyntheticFixture = {
  readonly fixture_id: string;
  readonly target: 'staging';
  readonly tag: string;
  readonly synthetic: true;
};

export type FixturePlanAction = {
  readonly operation: 'upsert_tagged_synthetic_fixture' | 'delete_tagged_synthetic_fixture';
  readonly target: 'staging';
  readonly fixture_id: string;
  readonly tag: string;
};

export type StagingFixturePlan = {
  readonly schema_version: typeof STAGING_FIXTURE_PLAN_SCHEMA_VERSION;
  readonly mode: FixturePlanMode;
  readonly target: 'staging';
  readonly tag: string;
  readonly actions: readonly FixturePlanAction[];
};

export interface StagingFixtureAdapter {
  readonly target: 'staging';
  execute(action: FixturePlanAction): Promise<void>;
}

export class StagingFixturePlanError extends Error {
  readonly name = 'StagingFixturePlanError';
}

export function createStagingSeedPlan(input: unknown): StagingFixturePlan {
  const request = parseRequest(input, 'seed');
  return buildPlan(request, 'seed');
}

export function createStagingCleanupPlan(input: unknown): StagingFixturePlan {
  const request = parseRequest(input, 'cleanup');
  return buildPlan(request, 'cleanup');
}

export async function executeStagingFixturePlan(
  plan: StagingFixturePlan,
  adapter: StagingFixtureAdapter,
): Promise<void> {
  assertPlanIsStagingOnly(plan);
  if (adapter.target !== 'staging') throw new StagingFixturePlanError('adapter must explicitly target staging');
  for (const action of plan.actions) await adapter.execute(action);
}

type FixtureRequest = {
  readonly target: 'staging';
  readonly tag: string;
  readonly fixtures: readonly TaggedSyntheticFixture[];
};

function parseRequest(input: unknown, mode: FixturePlanMode): FixtureRequest {
  const request = requireRecord(input, '$');
  requireExactKeys(request, '$', ['target', 'tag', 'fixtures']);
  if (request['target'] !== 'staging') {
    throw new StagingFixturePlanError(`${mode} plans may target staging only`);
  }
  const tag = requireTag(request['tag'], '$.tag');
  const fixtures = requireFixtures(request['fixtures'], tag);
  if (mode === 'seed' && fixtures.length === 0) {
    throw new StagingFixturePlanError('seed plans require at least one tagged synthetic fixture');
  }
  return { target: 'staging', tag, fixtures };
}

function requireFixtures(value: unknown, tag: string): readonly TaggedSyntheticFixture[] {
  if (!Array.isArray(value)) throw new StagingFixturePlanError('$.fixtures must be an array');
  const fixtures = value.map((fixture, index) => parseFixture(fixture, `$.fixtures[${index}]`, tag));
  const identifiers = new Set<string>();
  for (const fixture of fixtures) {
    if (identifiers.has(fixture.fixture_id)) {
      throw new StagingFixturePlanError(`duplicate staging fixture ID: ${fixture.fixture_id}`);
    }
    identifiers.add(fixture.fixture_id);
  }
  return fixtures;
}

function parseFixture(value: unknown, path: string, tag: string): TaggedSyntheticFixture {
  const fixture = requireRecord(value, path);
  requireExactKeys(fixture, path, ['fixture_id', 'target', 'tag', 'synthetic']);
  const fixtureId = requireString(fixture['fixture_id'], `${path}.fixture_id`);
  if (!FIXTURE_ID.test(fixtureId)) {
    throw new StagingFixturePlanError(`${path}.fixture_id must begin with stg_`);
  }
  if (fixture['target'] !== 'staging') {
    throw new StagingFixturePlanError(`${path}.target must be staging; non-staging deletion is forbidden`);
  }
  if (fixture['synthetic'] !== true) {
    throw new StagingFixturePlanError(`${path}.synthetic must be true; untagged data is forbidden`);
  }
  const fixtureTag = requireTag(fixture['tag'], `${path}.tag`);
  if (fixtureTag !== tag) {
    throw new StagingFixturePlanError(`${path}.tag must equal $.tag`);
  }
  return { fixture_id: fixtureId, target: 'staging', tag: fixtureTag, synthetic: true };
}

function buildPlan(request: FixtureRequest, mode: FixturePlanMode): StagingFixturePlan {
  const operation = mode === 'seed'
    ? 'upsert_tagged_synthetic_fixture' as const
    : 'delete_tagged_synthetic_fixture' as const;
  const fixtures = [...request.fixtures].sort((left, right) => compareFixtureIds(left.fixture_id, right.fixture_id));
  return {
    schema_version: STAGING_FIXTURE_PLAN_SCHEMA_VERSION,
    mode,
    target: 'staging',
    tag: request.tag,
    actions: fixtures.map((fixture) => ({
      operation,
      target: 'staging',
      fixture_id: fixture.fixture_id,
      tag: fixture.tag,
    })),
  };
}

function assertPlanIsStagingOnly(plan: StagingFixturePlan): void {
  if (plan.schema_version !== STAGING_FIXTURE_PLAN_SCHEMA_VERSION || plan.target !== 'staging') {
    throw new StagingFixturePlanError('only a staging fixture plan may execute');
  }
  const tag = requireTag(plan.tag, '$.tag');
  for (const action of plan.actions) {
    if (action.target !== 'staging' || action.tag !== tag || !FIXTURE_ID.test(action.fixture_id)) {
      throw new StagingFixturePlanError('fixture plans may execute only tagged staging actions');
    }
  }
}

function requireRecord(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new StagingFixturePlanError(`${path} must be an object`);
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireExactKeys(value: Readonly<Record<string, unknown>>, path: string, keys: readonly string[]): void {
  const missing = keys.filter((key) => value[key] === undefined);
  const unexpected = Object.keys(value).filter((key) => !keys.includes(key));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new StagingFixturePlanError(`${path} must contain exactly [${keys.join(', ')}]`);
  }
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new StagingFixturePlanError(`${path} must be a non-empty string`);
  }
  return value;
}

function requireTag(value: unknown, path: string): string {
  const tag = requireString(value, path);
  const runId = tag.slice(STAGING_FIXTURE_TAG_PREFIX.length);
  if (!tag.startsWith(STAGING_FIXTURE_TAG_PREFIX) || !RUN_ID.test(runId)) {
    throw new StagingFixturePlanError(`${path} must be a calledit:staging tagged run`);
  }
  return tag;
}

function compareFixtureIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
