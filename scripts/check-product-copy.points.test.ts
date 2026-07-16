import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runChecker } from './check-product-copy.test-support.js';

const APPROVED_GROUP_GUIDANCE = [
  'Choices and named results are visible to everyone in this Telegram group.',
  'Correct choices earn 10 points automatically.',
  'Test SOL has no monetary value.',
].join('\n');

test('rejects aggregate receipt wording across whitespace variants', () => {
  // Given
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'calledit-product-copy-'));
  const variants = ['aggregate receipt', 'aggregate\treceipt', 'aggregate\nreceipt', 'aggregate\u00a0receipt'];

  try {
    // When
    const results = variants.map((variant, index) => {
      const fixturePath = join(fixtureDirectory, `aggregate-${index}.md`);
      writeFileSync(fixturePath, `Test SOL has no monetary value.\n${variant}\n`, 'utf8');
      return runChecker(['--fixture', fixturePath]);
    });

    // Then
    for (const result of results) {
      assert.equal(result.status, 1);
      assert.match(result.stdout, /\[receipt\.aggregate-primary-path\]/);
    }
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test('accepts named-group points guidance while rejecting active points and Rep drift', () => {
  // Given
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'calledit-product-copy-'));
  const approvedPath = join(fixtureDirectory, 'approved.md');
  const pointsPath = join(fixtureDirectory, 'points.md');
  const repPath = join(fixtureDirectory, 'active.md');
  writeFileSync(approvedPath, `${APPROVED_GROUP_GUIDANCE}\n`, 'utf8');
  writeFileSync(pointsPath, `${APPROVED_GROUP_GUIDANCE}\nPoints leaderboard balance.\n`, 'utf8');
  writeFileSync(repPath, 'No mainnet is supported.\nPractice Rep\n', 'utf8');

  try {
    // When
    const approvedResult = runChecker(['--fixture', approvedPath]);
    const pointsResult = runChecker(['--fixture', pointsPath]);
    const repResult = runChecker(['--fixture', repPath]);

    // Then
    assert.equal(approvedResult.status, 0);
    assert.match(approvedResult.stdout, /PASS fixture \(1 file\)/);
    assert.equal(pointsResult.status, 1);
    assert.match(pointsResult.stdout, /\[economy\.points-primary-path\]/);
    assert.equal(repResult.status, 1);
    assert.match(repResult.stdout, /\[economy\.rep-primary-path\]/);
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});
