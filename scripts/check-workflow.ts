import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'yaml';

const workflowPath = '.github/workflows/ci.yml';
const execFileAsync = promisify(execFile);

type WorkflowStep = {
  readonly uses: string | undefined;
  readonly run: string | undefined;
};

type Workflow = {
  readonly jobs: readonly {
    readonly steps: readonly WorkflowStep[];
  }[];
};

const FLOATING_ACTION = /@(?:[a-z]+|v\d+)$/i;

async function main(): Promise<void> {
  const document: unknown = parse(await readFile(workflowPath, 'utf8'));
  const workflow = parseWorkflow(document);
  const steps = workflow.jobs.flatMap((job) => job.steps);
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

  const root = process.cwd();
  const manifestPaths = await discoverActivePackageManifests(root);
  await assertNoEmptySuiteEscapes(root, manifestPaths);
  const conciergeManifest = join(root, 'apps/concierge/package.json');
  if (manifestPaths.includes(conciergeManifest)) {
    const command = await loadCallieBuildCommand(root);
    console.log(`callie#build resolved to ${command}`);
  }

  console.log(`${workflowPath} parsed with ${steps.length} steps and no floating actions`);
}

async function discoverActivePackageManifests(root: string): Promise<readonly string[]> {
  const manifestPaths = [join(root, 'package.json')];
  for (const workspaceDirectory of ['apps', 'packages']) {
    const directory = join(root, workspaceDirectory);
    const entries = await readdir(directory, { withFileTypes: true });
    manifestPaths.push(
      ...entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(directory, entry.name, 'package.json')),
    );
  }
  return manifestPaths;
}

async function assertNoEmptySuiteEscapes(
  root: string,
  manifestPaths: readonly string[],
): Promise<void> {
  const offenders: string[] = [];
  for (const manifestPath of manifestPaths) {
    const document: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (!isRecord(document)) {
      throw new Error(`${relative(root, manifestPath)} must contain a JSON object`);
    }
    const scripts = document.scripts;
    if (scripts === undefined) {
      continue;
    }
    if (!isRecord(scripts)) {
      throw new Error(`${relative(root, manifestPath)} scripts must be a JSON object`);
    }
    if (Object.values(scripts).some(hasEmptySuiteEscape)) {
      offenders.push(relative(root, manifestPath));
    }
  }

  if (offenders.length > 0) {
    throw new Error(`passWithNoTests found in active package manifests: ${offenders.join(', ')}`);
  }
}

async function loadCallieBuildCommand(root: string): Promise<string> {
  const result = await execFileAsync(
    'npx',
    ['-y', 'pnpm@10.33.0', 'exec', 'turbo', 'run', 'build', '--dry=json', '--filter=callie'],
    { cwd: root, encoding: 'utf8' },
  );
  const document: unknown = JSON.parse(result.stdout);
  if (!isRecord(document) || !Array.isArray(document.tasks)) {
    throw new Error('Turbo dry run must contain a tasks sequence');
  }
  const task = document.tasks.find(isCallieBuildTask);
  if (task === undefined) {
    throw new Error('Turbo dry run is missing callie#build');
  }
  if (task.command === '<NONEXISTENT>') {
    throw new Error('Turbo resolves callie#build to NONEXISTENT');
  }
  return task.command;
}

function isCallieBuildTask(
  value: unknown,
): value is Readonly<Record<string, unknown>> & { readonly command: string } {
  return isRecord(value) && value.taskId === 'callie#build' && typeof value.command === 'string';
}

function hasEmptySuiteEscape(value: unknown): boolean {
  return typeof value === 'string' && value.includes('--passWithNoTests');
}

function parseWorkflow(document: unknown): Workflow {
  if (!isRecord(document)) {
    throw new Error('workflow must be a mapping');
  }
  const jobs = document.jobs;
  if (!isRecord(jobs)) {
    throw new Error('workflow jobs must be a mapping');
  }
  return {
    jobs: Object.entries(jobs).map(([name, job]) => parseJob(name, job)),
  };
}

function parseJob(name: string, value: unknown): Workflow['jobs'][number] {
  if (!isRecord(value)) {
    throw new Error(`workflow job ${name} must be a mapping`);
  }
  if (value.steps === undefined) {
    return { steps: [] };
  }
  if (!Array.isArray(value.steps)) {
    throw new Error(`workflow job ${name} steps must be a sequence`);
  }
  return {
    steps: value.steps.map((step, index) => parseStep(name, index, step)),
  };
}

function parseStep(jobName: string, index: number, value: unknown): WorkflowStep {
  if (!isRecord(value)) {
    throw new Error(`workflow job ${jobName} step ${index + 1} must be a mapping`);
  }
  return {
    uses: optionalString(value, 'uses', jobName, index),
    run: optionalString(value, 'run', jobName, index),
  };
}

function optionalString(
  value: Readonly<Record<string, unknown>>,
  field: 'uses' | 'run',
  jobName: string,
  index: number,
): string | undefined {
  const candidate = value[field];
  if (candidate === undefined || typeof candidate === 'string') {
    return candidate;
  }
  throw new Error(`workflow job ${jobName} step ${index + 1} ${field} must be a string`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
