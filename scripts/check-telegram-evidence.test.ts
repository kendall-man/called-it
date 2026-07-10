import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { TELEGRAM_EVIDENCE_FILES, checkTelegramEvidence } from './check-telegram-evidence.js';

const root = join(process.cwd(), '.tmp-telegram-evidence-test');

test.afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test('accepts sanitized Telegram evidence', async () => {
  await writeEvidence('TASK_9_TELEGRAM_RESTART_PASS\n', 'TAP version 13\nok 1 - durable retry\n');

  assert.deepEqual(await checkTelegramEvidence(root), []);
});

test('reports only rule and path when a private source key appears', async () => {
  await writeEvidence('TASK_9_TELEGRAM_RESTART_PASS\n', 'msg:-100:7\n');

  assert.deepEqual(await checkTelegramEvidence(root), [
    {
      rule: 'raw_source_key',
      path: '.omo/evidence/task-9-called-it-direct-onboarding-remediation.sql.tap',
    },
  ]);
});

test('reports absent required artifacts', async () => {
  assert.deepEqual(
    await checkTelegramEvidence(root),
    TELEGRAM_EVIDENCE_FILES.map((path) => ({ rule: 'artifact_missing', path })),
  );
});

async function writeEvidence(restart: string, sql: string): Promise<void> {
  for (const relativePath of TELEGRAM_EVIDENCE_FILES) {
    const path = join(root, relativePath);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, relativePath.endsWith('.tap') ? sql : restart, 'utf8');
  }
}
