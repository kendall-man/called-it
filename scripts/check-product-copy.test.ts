import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER_PATH = join(REPO_ROOT, 'scripts/check-product-copy.ts');
const COMMENT_TOKENS = new Set([
  ts.SyntaxKind.SingleLineCommentTrivia,
  ts.SyntaxKind.MultiLineCommentTrivia,
]);
const TASK_ONE_TYPESCRIPT_PATHS: readonly string[] = [
  'apps/concierge/agent/tools/get_my_wallet.ts',
  'apps/concierge/agent/tools/quote_claim.ts',
  'apps/engine/src/bot/copy.test.ts',
  'apps/engine/src/bot/copy.ts',
  'apps/engine/src/bot/fallback-copy.ts',
  'apps/engine/src/wager/constants.test.ts',
  'apps/engine/src/wager/copy.ts',
  'apps/web/app/page.test.ts',
  'apps/web/app/page.tsx',
  'packages/agent/src/persona.test.ts',
  'packages/agent/src/templates.ts',
  'scripts/check-product-copy.test.ts',
  'scripts/check-product-copy.ts',
  'scripts/product-copy-contract.ts',
];

function runChecker(args: readonly string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', CHECKER_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

function countPureLines(path: string): number {
  const source = readFileSync(path, 'utf8');
  const withoutComments = source.split('');
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.JSX, source);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (!COMMENT_TOKENS.has(token)) continue;
    for (let index = scanner.getTokenPos(); index < scanner.getTextPos(); index += 1) {
      if (withoutComments[index] !== '\n' && withoutComments[index] !== '\r') {
        withoutComments[index] = ' ';
      }
    }
  }
  return withoutComments
    .join('')
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0).length;
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

test('includes every active landing, engine copy, fallback, and concierge surface', () => {
  // Given
  const expectedPaths = [
    'apps/web/app/page.tsx',
    'apps/engine/src/bot/copy.ts',
    'apps/engine/src/bot/fallback-copy.ts',
    'apps/engine/src/wager/copy.ts',
    'packages/agent/src/templates.ts',
    'apps/concierge/agent/instructions/00-callie.md',
    'apps/concierge/agent/tools/quote_claim.ts',
  ];

  // When
  const result = runChecker([]);

  // Then
  assert.equal(result.status, 0);
  for (const path of expectedPaths) {
    assert.match(result.stdout, new RegExp(`SCAN [^\\n]*${path.replaceAll('.', '\\.')}`));
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

test('rejects real devnet SOL, cashout, load-stack, demo, and assigned hash CTA drift', () => {
  // Given
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'calledit-product-copy-'));
  const fixturePath = join(fixtureDirectory, 'active.tsx');
  writeFileSync(
    fixturePath,
    [
      'Real devnet SOL on the line.',
      'Cash out now.',
      'Load your stack.',
      'Join the demo group.',
      "const ACTION_URL = '#start';",
      'No Rep moves.',
    ].join('\n'),
    'utf8',
  );

  try {
    // When
    const result = runChecker(['--fixture', fixturePath]);

    // Then
    assert.equal(result.status, 1);
    assert.match(result.stdout, /\[value\.real-money-claim\]/);
    assert.match(result.stdout, /\[language\.cashout\]/);
    assert.match(result.stdout, /\[language\.stack\]/);
    assert.match(result.stdout, /\[onboarding\.demo-or-replay\]/);
    assert.match(result.stdout, /\[cta\.placeholder-href\]/);
    assert.match(result.stdout, /\[economy\.rep-primary-path\]/);
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

test('keeps the checker CLI below 250 non-comment lines', () => {
  // Given
  const source = readFileSync(CHECKER_PATH, 'utf8');

  // When
  const nonCommentLines = source.split(/\r?\n/u).filter((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith('//');
  });

  // Then
  assert.ok(nonCommentLines.length < 250, `checker has ${nonCommentLines.length} lines`);
});

test('keeps every audited Task 1 TypeScript surface at or below 250 pure lines', () => {
  // Given
  const limit = 250;

  // When
  const counts = TASK_ONE_TYPESCRIPT_PATHS.map((path): readonly [string, number] => [
    path,
    countPureLines(join(REPO_ROOT, path)),
  ]);

  // Then
  for (const [path, count] of counts) {
    assert.ok(count <= limit, `${path}: ${count} pure lines exceeds ${limit}`);
  }
});
