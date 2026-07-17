import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { validRestoreReport } from './restore/report-fixture.js';

const ROOT = process.cwd();
const VERIFIER = join(ROOT, 'scripts/verify-restore-report.ts');
const TSX = join(ROOT, 'node_modules/.bin/tsx');

test('validates a report file and emits machine-readable acceptance', async () => {
  // Given a complete redacted restore report on disk
  const fixture = await writeReport(validRestoreReport());
  try {
    // When the verifier runs against that report
    const result = await runVerifier(fixture.path);

    // Then it accepts the report with a JSON result
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { schema_version: 1, status: 'valid' });
  } finally {
    await fixture.cleanup();
  }
});

test('rejects an invalid report file with machine-readable violations', async () => {
  // Given a report whose PITR evidence is simulated
  const report = validRestoreReport();
  providerEvidence(report).execution = 'simulated';
  const fixture = await writeReport(report);
  try {
    // When the verifier runs
    const result = await runVerifier(fixture.path);

    // Then it returns a non-zero status and JSON violations
    assert.notEqual(result.code, 0);
    const output: unknown = JSON.parse(result.stderr);
    assert.ok(isRecord(output));
    assert.equal(output.status, 'invalid');
    assert.ok(Array.isArray(output.violations));
  } finally {
    await fixture.cleanup();
  }
});

type ReportFixture = {
  readonly path: string;
  readonly cleanup: () => Promise<void>;
};

type CommandResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

async function writeReport(report: Record<string, unknown>): Promise<ReportFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'calledit-restore-report-'));
  const path = join(directory, 'report.json');
  await writeFile(path, `${JSON.stringify(report)}\n`);
  return { path, cleanup: async () => rm(directory, { recursive: true, force: true }) };
}

async function runVerifier(path: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [VERIFIER, path], { cwd: ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function providerEvidence(report: Record<string, unknown>): Record<string, unknown> {
  const value = report.provider_restore_evidence;
  assert.ok(isRecord(value));
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
