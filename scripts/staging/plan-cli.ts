import { readFile } from 'node:fs/promises';

import {
  createStagingCleanupPlan,
  createStagingSeedPlan,
  type StagingFixturePlan,
} from './fixture-plan.js';

export async function runFixturePlanCli(
  mode: 'seed' | 'cleanup',
  values: readonly string[],
): Promise<StagingFixturePlan> {
  const inputPath = parseInputPath(values);
  const input: unknown = JSON.parse(await readFile(inputPath, 'utf8'));
  const plan = mode === 'seed' ? createStagingSeedPlan(input) : createStagingCleanupPlan(input);
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  return plan;
}

function parseInputPath(values: readonly string[]): string {
  if (values.length !== 2 || values[0] !== '--input' || values[1] === undefined) {
    throw new Error('usage: --input <tagged-staging-fixtures.json>');
  }
  return values[1];
}
