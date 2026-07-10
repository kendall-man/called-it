import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const TEST_DIR = 'tests/e2e';
const SPEC_PATTERN = /\.(?:spec|test)\.[cm]?[tj]s$/;

async function main(): Promise<void> {
  const files = await listFiles(TEST_DIR).catch((error: unknown) => {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  });
  const specs = files.filter((file) => SPEC_PATTERN.test(file));
  if (specs.length === 0) {
    throw new Error(`No browser tests found under ${TEST_DIR}; refusing to pass an empty suite`);
  }
  console.log(`Found ${specs.length} browser test files`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

async function listFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? listFiles(path) : [path];
    }),
  );
  return nested.flat();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
