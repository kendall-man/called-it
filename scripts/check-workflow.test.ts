import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const ROOT = process.cwd();
const CHECKER_PATH = join(ROOT, 'scripts/check-workflow.ts');
const TSX_PATH = join(ROOT, 'node_modules/.bin/tsx');

type CommandResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

test('rejects a major-only GitHub Action version', async () => {
  // Given a workflow pinned only to an action major version
  const workflow =
    `jobs:
  verify:
    steps:
      - uses: actions/checkout@v4
      - run: npx -y pnpm@10.33.0 install --frozen-lockfile
      - run: npx -y pnpm@10.33.0 verify
`;

  // When the repository workflow checker runs
  const result = await runWorkflowCheck(workflow);

  // Then the floating action is named as the reason for failure
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /floating actions: actions\/checkout@v4/);
});

test('rejects a workflow whose jobs value is not a mapping', async () => {
  // Given a workflow with a structurally invalid jobs value
  const workflow = 'jobs:\n  - verify\n';

  // When the repository workflow checker runs
  const result = await runWorkflowCheck(workflow);

  // Then it reports the boundary shape error
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /workflow jobs must be a mapping/);
});

test('rejects passWithNoTests in an active package manifest', async () => {
  // Given a repository fixture with an empty-suite escape in an active package
  const result = await runRepositoryCheck({
    '.github/workflows/ci.yml': workflowWithAction('actions/checkout@v4.2.2'),
    'package.json': '{"name":"fixture","private":true}',
    'apps/engine/package.json': '{"scripts":{"test":"vitest run --passWithNoTests"}}',
  });

  // When the repository workflow checker inspects package scripts
  // Then it rejects the exact manifest carrying the escape
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /passWithNoTests.*apps\/engine\/package\.json/);
});

test('requires Turbo to resolve the concierge build command', async () => {
  // Given the actual monorepo and its concierge workspace
  // When the repository workflow checker runs Turbo's build dry run
  const result = await runChecker(ROOT);

  // Then callie build is executable rather than a graph-only placeholder
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /callie#build resolved to .+eve:build/);
});

for (const action of [
  'actions/checkout@v4.2.2',
  'actions/checkout@0123456789abcdef0123456789abcdef01234567',
]) {
  test(`accepts the exact action reference ${action}`, async () => {
    // Given a workflow pinned to an exact action reference
    const workflow = workflowWithAction(action);

    // When the repository workflow checker runs
    const result = await runWorkflowCheck(workflow);

    // Then the workflow passes validation
    assert.equal(result.code, 0, result.stderr);
  });
}

async function runWorkflowCheck(workflow: string): Promise<CommandResult> {
  return runRepositoryCheck({ '.github/workflows/ci.yml': workflow });
}

async function runRepositoryCheck(
  files: Readonly<Record<string, string>>,
): Promise<CommandResult> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'calledit-workflow-'));
  try {
    await mkdir(join(fixtureRoot, 'apps'), { recursive: true });
    await mkdir(join(fixtureRoot, 'packages'), { recursive: true });
    const fixtureFiles = {
      'package.json': fixturePackageJson(),
      '.github/workflows/security.yml': securityWorkflow(),
      ...files,
    };
    for (const [path, contents] of Object.entries(fixtureFiles)) {
      const fixturePath = join(fixtureRoot, path);
      await mkdir(dirname(fixturePath), { recursive: true });
      await writeFile(fixturePath, contents);
    }
    return await runChecker(fixtureRoot);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

function workflowWithAction(action: string): string {
  return `jobs:
  verify:
    steps:
      - uses: ${action}
      - run: npx -y pnpm@10.33.0 install --frozen-lockfile
      - run: npx -y pnpm@10.33.0 verify
`;
}

function fixturePackageJson(): string {
  return JSON.stringify({
    name: 'fixture',
    private: true,
    scripts: {
      'test:dependency-policy': 'node scripts/security/dependency-policy.mjs --audit audit.json',
      verify: 'pnpm run test:dependency-policy',
    },
  });
}

function securityWorkflow(): string {
  return `jobs:
  security:
    steps:
      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567
      - run: npx -y pnpm@10.33.0 install --frozen-lockfile
      - run: node scripts/security/lock-integrity.mjs
      - run: node scripts/security/dependency-policy.mjs --audit audit.json
`;
}

async function runChecker(cwd: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX_PATH, [CHECKER_PATH], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}
