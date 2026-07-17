import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CHECKER_PATH = join(REPO_ROOT, 'scripts/check-product-copy.ts');

export function runChecker(args: readonly string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', CHECKER_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}
