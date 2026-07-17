import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { MigrationChecksum, SourceEvidence } from './contract.js';

const execFileAsync = promisify(execFile);
const COMMIT = /^[a-f0-9]{40}$/u;

export class SourceEvidenceError extends Error {
  readonly name = 'SourceEvidenceError';
}

export async function collectSourceEvidence(root: string): Promise<SourceEvidence> {
  await assertReleaseInputsAreTrackedAndClean(root);
  const [commit, lockfile, migrations] = await Promise.all([
    git(root, ['rev-parse', 'HEAD']),
    readFile(join(root, 'pnpm-lock.yaml'), 'utf8'),
    collectTrackedMigrationChecksums(root),
  ]);
  const sourceCommit = commit.trim();
  if (!COMMIT.test(sourceCommit)) throw new SourceEvidenceError('git HEAD must resolve to a full commit hash');
  return {
    source_commit: sourceCommit,
    pnpm_lock_sha256: sha256(lockfile),
    migrations,
  };
}

async function assertReleaseInputsAreTrackedAndClean(root: string): Promise<void> {
  try {
    await git(root, ['diff', '--quiet', '--exit-code', '--', 'pnpm-lock.yaml', 'packages/db/migrations']);
  } catch (error) {
    if (error instanceof SourceEvidenceError) {
      throw new SourceEvidenceError('pnpm-lock.yaml and packages/db/migrations must be committed before manifest generation');
    }
    throw error;
  }
}

async function collectTrackedMigrationChecksums(root: string): Promise<readonly MigrationChecksum[]> {
  const migrationRoot = join(root, 'packages/db/migrations');
  const [trackedOutput, entries] = await Promise.all([
    git(root, ['ls-files', '--', 'packages/db/migrations']),
    readdir(migrationRoot),
  ]);
  const tracked = trackedOutput
    .split(/\r?\n/u)
    .filter((path) => path.endsWith('.sql'))
    .sort();
  const onDisk = entries
    .filter((entry) => entry.endsWith('.sql'))
    .map((entry) => `packages/db/migrations/${entry}`)
    .sort();
  if (!sameStrings(tracked, onDisk)) {
    throw new SourceEvidenceError('all migration files must be tracked before manifest generation');
  }
  if (tracked.length === 0) throw new SourceEvidenceError('at least one tracked migration is required');
  return Promise.all(tracked.map(async (path) => ({ path, sha256: sha256(await readFile(join(root, path), 'utf8')) })));
}

async function git(root: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync('git', ['-C', root, ...args]);
    return result.stdout;
  } catch {
    throw new SourceEvidenceError(`git ${args[0] ?? 'command'} failed`);
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
