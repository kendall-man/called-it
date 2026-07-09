import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER_PATH = join(REPO_ROOT, 'scripts/check-product-copy.ts');

function runChecker(args: readonly string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', CHECKER_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

test('reports both contract violations when a fixture mixes Practice Rep with a placeholder CTA', () => {
  // Given
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'calledit-product-copy-'));
  const fixturePath = join(fixtureDirectory, 'surface.tsx');
  writeFileSync(fixturePath, 'Practice Rep\n<a href="#">Start</a>\n', 'utf8');

  try {
    // When
    const result = runChecker(['--fixture', fixturePath]);

    // Then
    assert.equal(result.status, 1);
    assert.match(result.stdout, /\[economy\.rep-primary-path\]/);
    assert.match(result.stdout, /\[cta\.placeholder-href\]/);
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test('rejects a malformed UTF-8 fixture at the CLI boundary', () => {
  // Given
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'calledit-product-copy-'));
  const fixturePath = join(fixtureDirectory, 'malformed.tsx');
  writeFileSync(fixturePath, Uint8Array.of(0xff));

  try {
    // When
    const result = runChecker(['--fixture', fixturePath]);

    // Then
    assert.equal(result.status, 2);
    assert.match(result.stderr, /\[input\.invalid-fixture\]/);
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test('reports every tracked product-copy surface when the contract is clean', () => {
  // Given
  const expectedSurfaces = ['guidance', 'bot', 'concierge', 'web'];

  // When
  const result = runChecker([]);

  // Then
  assert.equal(result.status, 0);
  for (const surface of expectedSurfaces) {
    assert.match(result.stdout, new RegExp(`PASS ${surface} \\([1-9][0-9]* files?\\)`));
  }
});

test('allows a historical migration label split across adjacent lines', () => {
  // Given
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'calledit-product-copy-'));
  const fixturePath = join(fixtureDirectory, 'migration.md');
  writeFileSync(fixturePath, 'Historical migration field:\nRep\n', 'utf8');

  try {
    // When
    const result = runChecker(['--fixture', fixturePath]);

    // Then
    assert.equal(result.status, 0);
    assert.match(result.stdout, /PASS fixture \(1 file\)/);
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test('does not let an unrelated negative sentence exempt active Rep copy', () => {
  // Given
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'calledit-product-copy-'));
  const fixturePath = join(fixtureDirectory, 'active.md');
  writeFileSync(fixturePath, 'No mainnet is supported.\nPractice Rep\n', 'utf8');

  try {
    // When
    const result = runChecker(['--fixture', fixturePath]);

    // Then
    assert.equal(result.status, 1);
    assert.match(result.stdout, /\[economy\.rep-primary-path\]/);
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test('rejects simulated onboarding, misleading starter funds, and a real-value claim', () => {
  // Given
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'calledit-product-copy-'));
  const fixturePath = join(fixtureDirectory, 'drift.md');
  writeFileSync(
    fixturePath,
    'Join the replay tutorial.\nStarter grant is free money.\nThis SOL has real value.\n',
    'utf8',
  );

  try {
    // When
    const result = runChecker(['--fixture', fixturePath]);

    // Then
    assert.equal(result.status, 1);
    assert.match(result.stdout, /\[onboarding\.demo-or-replay\]/);
    assert.match(result.stdout, /\[starter\.misleading-funds\]/);
    assert.match(result.stdout, /\[value\.real-money-claim\]/);
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test('prints CLI usage without scanning when help is requested', () => {
  // Given
  const args = ['--help'];

  // When
  const result = runChecker(args);

  // Then
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: check-product-copy/);
});
