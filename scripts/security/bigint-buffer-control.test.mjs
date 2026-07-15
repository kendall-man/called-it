import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { parse } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SELECTOR = 'bigint-buffer@1.1.5';
const PATCH_PATH = 'patches/bigint-buffer@1.1.5.patch';

test('pins the bigint-buffer native-build prohibition and source patch', async () => {
  const [workspaceSource, manifestSource, patchSource] = await Promise.all([
    readFile(join(ROOT, 'pnpm-workspace.yaml'), 'utf8'),
    readFile(join(ROOT, 'package.json'), 'utf8'),
    readFile(join(ROOT, PATCH_PATH), 'utf8'),
  ]);
  const workspace = parse(workspaceSource);
  const manifest = JSON.parse(manifestSource);

  assert.equal(workspace.allowBuilds?.['bigint-buffer'], false);
  assert.equal(manifest.pnpm?.patchedDependencies?.[SELECTOR], PATCH_PATH);
  assert.doesNotMatch(patchSource, /^\+.*require\(['"]bindings['"]\)/mu);
  assert.match(patchSource, /^\+const converter = undefined;$/mu);
});

test('installed bigint-buffer uses pure JavaScript for oversized input', async () => {
  const store = join(ROOT, 'node_modules', '.pnpm');
  const entries = await readdir(store);
  const packageDirectory = entries.find((entry) => entry.startsWith(`${SELECTOR}_patch_hash=`));
  assert.ok(packageDirectory, 'the patched bigint-buffer package must be installed');

  const packageRoot = join(store, packageDirectory, 'node_modules', 'bigint-buffer');
  const files = await readdir(packageRoot, { recursive: true });
  assert.equal(files.some((file) => file.endsWith('.node')), false, 'native bindings must be absent');

  const mainPath = join(packageRoot, 'dist', 'node.js');
  const mainSource = await readFile(mainPath, 'utf8');
  assert.doesNotMatch(mainSource, /require\(['"]bindings['"]\)/u);

  const { toBigIntLE } = createRequire(import.meta.url)(mainPath);
  const input = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 256));
  const expected = BigInt(`0x${Buffer.from(input).reverse().toString('hex')}`);
  assert.equal(toBigIntLE(input), expected);
});
