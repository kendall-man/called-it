import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HARD_GATES,
  RELEASE_MARKERS,
  sha256Hex,
  validateReleaseScorecard,
} from './observability/scorecard.js';

const COMMIT = 'b9f327b1e4bb4cfdb0a5626fe1e814955d78d66f';
const ENVIRONMENT = 'production-canary';
const NOW = '2026-07-11T10:00:00.000Z';
const EVIDENCE_PATH = 'evidence/scorecard-machine.json';

test('returns limited_beta_go when all 140 named checks and hard gates have fresh hashed machine evidence', async () => {
  // Given
  const contents = machineEvidence();
  const bundle = scorecardBundle(sha256Hex(contents));

  // When
  const result = await validateReleaseScorecard(bundle, {
    currentGitSha: COMMIT,
    now: NOW,
    readEvidence: async (path) => (path === EVIDENCE_PATH ? contents : null),
  });

  // Then
  assert.equal(result.decision, 'limited_beta_go', JSON.stringify(result));
  assert.equal(result.markers.length, 14);
  assert.equal(RELEASE_MARKERS.flatMap((marker) => marker.checks).length, 140);
  assert.ok(result.markers.every((marker) => marker.passed_checks === 10));
  assert.equal(result.hard_gates.passed, true);
});

test('returns no_go for missing or stale evidence, a failed hard gate, or a freehand score field', async () => {
  // Given
  const passingContents = machineEvidence();
  const passingBundle = scorecardBundle(sha256Hex(passingContents));
  const missingCheckBundle = {
    ...passingBundle,
    markers: passingBundle.markers.map((marker, index) => index === 0
      ? { ...marker, checks: marker.checks.slice(1) }
      : marker),
  };
  const failedGateContents = machineEvidence(HARD_GATES[0]);
  const failedGateBundle = scorecardBundle(sha256Hex(failedGateContents));
  const staleContents = machineEvidence(undefined, '2026-07-09T09:59:00.000Z');
  const staleBundle = scorecardBundle(sha256Hex(staleContents));
  const freehandScoreBundle = { ...passingBundle, score: 10 };

  // When
  const [missingCheck, failedGate, staleEvidence, freehandScore] = await Promise.all([
    validateReleaseScorecard(missingCheckBundle, scorecardOptions(passingContents)),
    validateReleaseScorecard(failedGateBundle, scorecardOptions(failedGateContents)),
    validateReleaseScorecard(staleBundle, scorecardOptions(staleContents)),
    validateReleaseScorecard(freehandScoreBundle, scorecardOptions(passingContents)),
  ]);

  // Then
  assert.equal(missingCheck.decision, 'no_go');
  assert.equal(failedGate.decision, 'no_go');
  assert.equal(staleEvidence.decision, 'no_go');
  assert.equal(freehandScore.decision, 'no_go');
});

function scorecardOptions(contents: string) {
  return {
    currentGitSha: COMMIT,
    now: NOW,
    readEvidence: async (path: string) => (path === EVIDENCE_PATH ? contents : null),
  };
}

function scorecardBundle(hash: string) {
  const reference = { path: EVIDENCE_PATH, sha256: hash };
  return {
    schema_version: 1,
    release_commit: COMMIT,
    environment: ENVIRONMENT,
    created_at: NOW,
    markers: RELEASE_MARKERS.map((marker) => ({
      id: marker.id,
      checks: marker.checks.map((check) => ({ id: check.id, evidence: [reference] })),
    })),
    hard_gates: HARD_GATES.map((id) => ({ id, evidence: [reference] })),
  };
}

function machineEvidence(failedGate?: string, capturedAt = '2026-07-11T09:59:00.000Z'): string {
  return JSON.stringify({
    schema_version: 1,
    kind: 'calledit.machine_evidence',
    release_commit: COMMIT,
    environment: ENVIRONMENT,
    captured_at: capturedAt,
    results: [
      ...RELEASE_MARKERS.flatMap((marker) => marker.checks.map((check) => ({
        target: { kind: 'marker', marker_id: marker.id, check_id: check.id },
        outcome: 'passed',
        command_id: 'ci.release_check',
      }))),
      ...HARD_GATES.map((id) => ({
        target: { kind: 'hard_gate', id },
        outcome: id === failedGate ? 'failed' : 'passed',
        command_id: 'ci.release_gate',
        ...(id === failedGate ? { reason_code: 'hard_gate_failed' } : {}),
      })),
    ],
  });
}
