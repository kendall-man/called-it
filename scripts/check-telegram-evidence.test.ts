import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  TELEGRAM_EVIDENCE_LEAK_RULE_ID,
  TELEGRAM_EVIDENCE_MISSING_ARTIFACT_RULE_ID,
  TelegramEvidenceCheckError,
  scanTelegramEvidence,
} from './check-telegram-evidence.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER_PATH = join(REPO_ROOT, 'scripts/check-telegram-evidence.ts');

type EvidenceFixture = {
  readonly directory: string;
  readonly artifactPaths: readonly [string, string];
};

function createEvidenceFixture(contents: readonly [string, string]): EvidenceFixture {
  const directory = mkdtempSync(join(tmpdir(), 'calledit-telegram-evidence-'));
  const textPath = join(directory, 'task-9.txt');
  const tapPath = join(directory, 'task-9.sql.tap');
  writeFileSync(textPath, contents[0], 'utf8');
  writeFileSync(tapPath, contents[1], 'utf8');
  return { directory, artifactPaths: [textPath, tapPath] };
}

function captureScannerError(action: () => void): TelegramEvidenceCheckError {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof TelegramEvidenceCheckError);
  return thrown;
}

function runChecker(artifactPaths: readonly string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', CHECKER_PATH, ...artifactPaths], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

test('passes clean Task 9 evidence when forbidden values are absent', () => {
  // Given
  const fixture = createEvidenceFixture([
    'command: test:sql\nexit_status: 0\ntest_count: 42\npostgres_version: 16\nsource_fingerprint: safe-fingerprint\n',
    'TAP version 13\nok 1 - lease contract\nok 2 - retention contract\n',
  ]);

  try {
    // When
    assert.doesNotThrow(() => {
      scanTelegramEvidence(fixture.artifactPaths, ['CHAT_CANARY', 'MESSAGE_CANARY']);
    });
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

for (const canary of [
  { name: 'chat', value: 'chat_id=-1000123456789', matcher: 'chat_id=-1000123456789' },
  { name: 'message', value: 'message_id=908172635', matcher: 'message_id=908172635' },
  {
    name: 'callback',
    value: 'callback_id=private-callback-908172635',
    matcher: /callback_id=private-callback-908172635/u,
  },
  {
    name: 'text',
    value: 'text=private-message-body-908172635',
    matcher: 'text=private-message-body-908172635',
  },
] as const) {
  test(`fails without disclosing a raw ${canary.name} canary`, () => {
    // Given
    const fixture = createEvidenceFixture([`${canary.value}\n`, 'TAP version 13\nok 1 - generic\n']);

    try {
      // When
      const error = captureScannerError(() => {
        scanTelegramEvidence(fixture.artifactPaths, [canary.matcher]);
      });

      // Then
      assert.equal(error.ruleId, TELEGRAM_EVIDENCE_LEAK_RULE_ID);
      assert.equal(error.artifactPath, fixture.artifactPaths[0]);
      assert.equal(
        error.message,
        `[${TELEGRAM_EVIDENCE_LEAK_RULE_ID}] ${fixture.artifactPaths[0]}`,
      );
      assert.equal(String(error).includes(canary.value), false);
      assert.equal(error.message.includes(canary.value), false);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });
}

test('rejects a missing artifact with a privacy-safe error', () => {
  // Given
  const fixture = createEvidenceFixture(['safe\n', 'TAP version 13\nok 1 - generic\n']);
  const missingPath = join(fixture.directory, 'missing-evidence.txt');

  try {
    // When
    const error = captureScannerError(() => {
      scanTelegramEvidence([missingPath, fixture.artifactPaths[1]], ['CHAT_CANARY']);
    });

    // Then
    assert.equal(error.ruleId, TELEGRAM_EVIDENCE_MISSING_ARTIFACT_RULE_ID);
    assert.equal(error.artifactPath, missingPath);
    assert.equal(error.message, `[${TELEGRAM_EVIDENCE_MISSING_ARTIFACT_RULE_ID}] ${missingPath}`);
    assert.equal(error.message.includes('ENOENT'), false);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('runs from the CLI and emits no matched source key', () => {
  // Given
  const rawSourceKey = 'msg:-1000123456789:908172635';
  const fixture = createEvidenceFixture([
    `source_key=${rawSourceKey}\n`,
    'TAP version 13\nok 1 - generic\n',
  ]);

  try {
    // When
    const result = runChecker(fixture.artifactPaths);

    // Then
    assert.equal(result.status, 1);
    assert.equal(result.stderr, `[${TELEGRAM_EVIDENCE_LEAK_RULE_ID}] ${fixture.artifactPaths[0]}\n`);
    assert.equal(result.stderr.includes(rawSourceKey), false);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('rejects a missing artifact from the CLI without filesystem details', () => {
  // Given
  const fixture = createEvidenceFixture(['safe\n', 'TAP version 13\nok 1 - generic\n']);
  const missingPath = join(fixture.directory, 'missing-evidence.txt');

  try {
    // When
    const result = runChecker([missingPath, fixture.artifactPaths[1]]);

    // Then
    assert.equal(result.status, 1);
    assert.equal(
      result.stderr,
      `[${TELEGRAM_EVIDENCE_MISSING_ARTIFACT_RULE_ID}] ${missingPath}\n`,
    );
    assert.equal(result.stderr.includes('ENOENT'), false);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
