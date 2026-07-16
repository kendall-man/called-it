import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { LockIntegrityError, verifyLockIntegrity } from './lock-integrity.mjs';

test('verifies the tracked pnpm lock against every workspace manifest', async () => {
  // Given
  const root = join(process.cwd());

  // When
  const result = await verifyLockIntegrity({ root });

  // Then
  assert.equal(result.status, 'pass');
  assert.equal(result.lockfile, 'pnpm-lock.yaml');
  assert.match(result.sha256, /^[a-f0-9]{64}$/u);
  assert.ok(result.registry_package_count > 0);
});

test('fails when a registry package omits its integrity hash', async (context) => {
  // Given
  const root = await createFixture(context, lockfileWithoutIntegrity());

  // When
  const result = verifyLockIntegrity({ root });

  // Then
  await assert.rejects(result, LockIntegrityError);
  await assert.rejects(result, /integrity/);
});

test('fails when a lock importer no longer matches its manifest specifier', async (context) => {
  // Given
  const root = await createFixture(context, validLockfile({ specifier: '^3.0.0' }));

  // When
  const result = verifyLockIntegrity({ root });

  // Then
  await assert.rejects(result, LockIntegrityError);
  await assert.rejects(result, /specifier mismatch/);
});

test('fails when a tracked override is not bound to package.json', async (context) => {
  const root = await createFixture(context, validLockfile().replace(
    'importers:\n',
    'overrides:\n  example: 2.0.0\nimporters:\n',
  ), { pnpm: { overrides: { example: '2.0.1' } } });

  await assert.rejects(verifyLockIntegrity({ root }), /lock override example does not match/);
});

test('fails when a tracked dependency patch is not bound to package.json', async (context) => {
  const root = await createFixture(context, validLockfile().replace(
    'importers:\n',
    `patchedDependencies:\n  example@1.0.0:\n    hash: ${'0'.repeat(64)}\n    path: patches/example.patch\nimporters:\n`,
  ), { pnpm: { patchedDependencies: { 'example@1.0.0': 'patches/other.patch' } } });

  await assert.rejects(verifyLockIntegrity({ root }), /lock patch example@1.0.0 does not match/);
});

async function createFixture(context, lockfile, rootFields = {}) {
  const root = await mkdtemp(join(tmpdir(), 'calledit-lock-integrity-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(join(root, 'apps', 'engine'), { recursive: true }),
    mkdir(join(root, 'packages'), { recursive: true }),
  ]);
  await writeFile(join(root, 'pnpm-lock.yaml'), lockfile, 'utf8');
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', private: true, packageManager: 'pnpm@10.33.0', ...rootFields }),
    'utf8',
  );
  await writeFile(
    join(root, 'apps', 'engine', 'package.json'),
    JSON.stringify({ name: 'engine', dependencies: { example: '^2.0.0' } }),
    'utf8',
  );
  return root;
}

function validLockfile({ specifier = '^2.0.0' } = {}) {
  return `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
importers:
  .: {}
  apps/engine:
    dependencies:
      example:
        specifier: ${specifier}
        version: 2.0.0
packages:
  example@2.0.0:
    resolution:
      integrity: sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==
snapshots: {}
`;
}

function lockfileWithoutIntegrity() {
  return validLockfile().replace(
    '      integrity: sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==\n',
    '',
  );
}
