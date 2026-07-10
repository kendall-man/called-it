import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

const workflowPath = '.github/workflows/ci.yml';

type WorkflowStep = {
  readonly uses?: string;
  readonly run?: string;
};

type Workflow = {
  readonly jobs?: Record<string, {
    readonly steps?: readonly WorkflowStep[];
  }>;
};

const FLOATING_ACTION = /@[a-z]+$/i;

async function main(): Promise<void> {
  const workflow = parse(await readFile(workflowPath, 'utf8')) as Workflow;
  const jobs = workflow.jobs ?? {};
  const steps = Object.values(jobs).flatMap((job) => job.steps ?? []);
  const floatingActions = steps
    .map((step) => step.uses)
    .filter((uses): uses is string => uses !== undefined)
    .filter((uses) => FLOATING_ACTION.test(uses));

  if (floatingActions.length > 0) {
    throw new Error(`workflow uses floating actions: ${floatingActions.join(', ')}`);
  }

  const runCommands = steps.map((step) => step.run ?? '').join('\n');
  for (const required of [
    'pnpm@10.33.0 install --frozen-lockfile',
    'pnpm@10.33.0 verify',
  ]) {
    if (!runCommands.includes(required)) {
      throw new Error(`workflow missing command: ${required}`);
    }
  }

  console.log(`${workflowPath} parsed with ${steps.length} steps and no floating actions`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
