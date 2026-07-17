import assert from 'node:assert/strict';
import test from 'node:test';

import { validRestoreReport } from './report-fixture.js';
import { validateRestoreReport } from './report-validation.js';

test('accepts a redacted isolated PITR rehearsal report with matching comparisons', () => {
  // Given a complete, redacted report produced after an isolated restore
  const report = validRestoreReport();

  // When the report is validated
  const result = validateRestoreReport(report);

  // Then it is accepted for the decision gate
  assert.deepEqual(result, { kind: 'valid' });
});

test('rejects a report with a missing required comparison', () => {
  // Given a restore report without its proof state comparison
  const report = validRestoreReport();
  delete report.proofs;

  // When the report is validated
  const result = validateRestoreReport(report);

  // Then the missing comparison blocks acceptance
  assertInvalidAt(result, '$.proofs');
});

test('rejects reverse migration instructions', () => {
  // Given a forward-only rollback report that contains a reverse migration step
  const report = validRestoreReport();
  appRollback(report).instructions = ['Run reverse migrations before deploying the previous release.'];

  // When the report is validated
  const result = validateRestoreReport(report);

  // Then the prohibited migration direction is named
  assertInvalidAt(result, '$.app_rollback.instructions[0]');
});

test('rejects a non-isolated target', () => {
  // Given a report whose restore target is the live environment
  const report = validRestoreReport();
  target(report).is_live = true;

  // When the report is validated
  const result = validateRestoreReport(report);

  // Then live restore is blocked
  assertInvalidAt(result, '$.target.is_live');
});

test('rejects an unredacted secret-like field', () => {
  // Given a report that includes a raw API token
  const report = validRestoreReport();
  report.api_token = 'live-token-material';

  // When the report is validated
  const result = validateRestoreReport(report);

  // Then redaction is enforced
  assertInvalidAt(result, '$.api_token');
});

test('rejects an incompatible application while a write flag is enabled', () => {
  // Given a rollback target incompatible with enabled write paths
  const report = validRestoreReport();
  flags(report).writes_enabled = true;

  // When the report is validated
  const result = validateRestoreReport(report);

  // Then the rollback cannot be accepted
  assertInvalidAt(result, '$.app_rollback');
});

test('rejects an invariant mismatch', () => {
  // Given a restore report whose liability invariant failed on the target
  const report = validRestoreReport();
  invariant(report, 'liability_reconciles').target = 'fail';

  // When the report is validated
  const result = validateRestoreReport(report);

  // Then the comparison failure blocks acceptance
  assertInvalidAt(result, '$.invariants');
});

test('rejects timing outside the RPO objective', () => {
  // Given a restore whose source consistency point is more than fifteen minutes old
  const report = validRestoreReport();
  timing(report).source_last_consistent_at = '2026-07-11T09:40:00.000Z';
  timing(report).rpo_minutes = 20;

  // When the report is validated
  const result = validateRestoreReport(report);

  // Then the RPO acceptance gate fails
  assertInvalidAt(result, '$.timing.rpo_minutes');
});

test('rejects provider evidence that was not executed with external credentials', () => {
  // Given a report asserting a simulated restore
  const report = validRestoreReport();
  providerEvidence(report).execution = 'simulated';

  // When the report is validated
  const result = validateRestoreReport(report);

  // Then a fabricated provider action cannot count as evidence
  assertInvalidAt(result, '$.provider_restore_evidence.execution');
});

function target(report: Record<string, unknown>): Record<string, unknown> {
  return objectAt(report, 'target');
}

function flags(report: Record<string, unknown>): Record<string, unknown> {
  return objectAt(objectAt(report, 'safe_state'), 'feature_flags');
}

function appRollback(report: Record<string, unknown>): Record<string, unknown> {
  return objectAt(report, 'app_rollback');
}

function timing(report: Record<string, unknown>): Record<string, unknown> {
  return objectAt(report, 'timing');
}

function providerEvidence(report: Record<string, unknown>): Record<string, unknown> {
  return objectAt(report, 'provider_restore_evidence');
}

function invariant(report: Record<string, unknown>, name: string): Record<string, unknown> {
  const invariants = arrayAt(report, 'invariants');
  const match = invariants.find((candidate) => stringAt(candidate, 'name') === name);
  assert.ok(match, `missing invariant fixture for ${name}`);
  return match;
}

function objectAt(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  assert.ok(isRecord(value), `${key} must be an object`);
  return value;
}

function arrayAt(parent: Record<string, unknown>, key: string): readonly Record<string, unknown>[] {
  const value = parent[key];
  assert.ok(Array.isArray(value), `${key} must be an array`);
  assert.ok(value.every(isRecord), `${key} must contain objects`);
  return value;
}

function stringAt(parent: Record<string, unknown>, key: string): string | undefined {
  const value = parent[key];
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertInvalidAt(result: ReturnType<typeof validateRestoreReport>, path: string): void {
  assert.equal(result.kind, 'invalid');
  assert.ok(result.violations.some((violation) => violation.path.startsWith(path)));
}
