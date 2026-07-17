import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReleaseScorecard } from './observability/scorecard.js';

type CliInput = {
  readonly bundle: string;
  readonly currentGitSha: string;
  readonly now: string;
};

async function main(args: readonly string[]): Promise<void> {
  const input = parseArguments(args);
  if (input === null) return writeDecision('no_go');
  try {
    const bundleText = await readFile(input.bundle, 'utf8');
    const bundle: unknown = JSON.parse(bundleText);
    const evidenceRoot = dirname(input.bundle);
    const result = await validateReleaseScorecard(bundle, {
      currentGitSha: input.currentGitSha,
      now: input.now,
      readEvidence: async (path) => readEvidence(evidenceRoot, path),
    });
    writeDecision(result.decision);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof Error) {
      writeDecision('no_go');
      return;
    }
    throw error;
  }
}

function parseArguments(args: readonly string[]): CliInput | null {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined || !isFlag(flag)) return null;
    values.set(flag, value);
  }
  const bundle = values.get('--bundle');
  const currentGitSha = values.get('--current-git-sha');
  const now = values.get('--now');
  if (values.size !== 3 || bundle === undefined || currentGitSha === undefined || now === undefined) return null;
  return { bundle: resolve(bundle), currentGitSha, now };
}

async function readEvidence(root: string, path: string): Promise<string | null> {
  const resolvedPath = resolve(root, path);
  const pathFromRoot = relative(root, resolvedPath);
  if (pathFromRoot === '' || pathFromRoot.startsWith('../') || pathFromRoot === '..') return null;
  try {
    return await readFile(resolvedPath, 'utf8');
  } catch (error) {
    if (error instanceof Error) return null;
    throw error;
  }
}

function isFlag(value: string | undefined): value is '--bundle' | '--current-git-sha' | '--now' {
  return value === '--bundle' || value === '--current-git-sha' || value === '--now';
}

function writeDecision(decision: 'limited_beta_go' | 'no_go'): void {
  process.stdout.write(`${decision}\n`);
  if (decision === 'no_go') process.exitCode = 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2));
}
