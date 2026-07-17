import { createHash } from 'node:crypto';
import { HARD_GATES, RELEASE_MARKERS } from './scorecard-markers.js';
import { isCommit, isTimestamp, parseMachineEvidence, parseReleaseScorecardBundle } from './scorecard-parser.js';
import type {
  EvidenceReference,
  MachineEvidence,
  MachineEvidenceTarget,
  ReleaseScorecardBundle,
  ReleaseScorecardResult,
  ScorecardFailureCode,
  ScorecardMarkerInput,
  ScorecardMarkerResult,
  ScorecardValidationOptions,
} from './scorecard-types.js';

export { HARD_GATES, RELEASE_MARKERS } from './scorecard-markers.js';
export type { ReleaseScorecardResult, ScorecardValidationOptions } from './scorecard-types.js';

const MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1_000;

export async function validateReleaseScorecard(
  input: unknown,
  options: ScorecardValidationOptions,
): Promise<ReleaseScorecardResult> {
  const failures = new Set<ScorecardFailureCode>();
  const bundle = parseReleaseScorecardBundle(input);
  if (bundle === null) return noGo(failures, 'bundle_malformed');
  if (!isCommit(options.currentGitSha)) return noGo(failures, 'current_commit_invalid', bundle);
  if (bundle.release_commit !== options.currentGitSha) failures.add('release_commit_mismatch');

  const now = parseTimestamp(options.now, failures, 'timestamp_invalid');
  const createdAt = parseTimestamp(bundle.created_at, failures, 'timestamp_invalid');
  if (now !== null && createdAt !== null && !isFresh(createdAt, now)) failures.add('bundle_stale');

  const markers = await validateMarkers(bundle, options, now, failures);
  const hardGateFailures = await validateHardGates(bundle, options, now, failures);
  if (markers.some((marker) => marker.score < 9 || !marker.mandatory_passed)) failures.add('check_shape_invalid');
  return {
    schema_version: 1,
    release_commit: bundle.release_commit,
    environment: bundle.environment,
    markers,
    hard_gates: { passed: hardGateFailures.length === 0, failures: hardGateFailures },
    decision: failures.size === 0 && hardGateFailures.length === 0 ? 'limited_beta_go' : 'no_go',
    failures: [...failures].sort(),
  };
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function validateMarkers(
  bundle: ReleaseScorecardBundle,
  options: ScorecardValidationOptions,
  now: number | null,
  failures: Set<ScorecardFailureCode>,
): Promise<readonly ScorecardMarkerResult[]> {
  if (!hasExactIds(bundle.markers, RELEASE_MARKERS)) failures.add('marker_shape_invalid');
  const results: ScorecardMarkerResult[] = [];
  for (const definition of RELEASE_MARKERS) {
    const inputs = bundle.markers.filter((marker) => marker.id === definition.id);
    const input = inputs.length === 1 ? inputs.at(0) ?? null : null;
    if (input === null || !hasExactIds(input.checks, definition.checks)) failures.add('check_shape_invalid');
    const checks = await Promise.all(definition.checks.map(async (check) => {
      const matching = input?.checks.filter((candidate) => candidate.id === check.id) ?? [];
      if (matching.length !== 1) return false;
      const checkInput = matching.at(0);
      if (checkInput === undefined) return false;
      return evidencePasses(checkInput.evidence, { kind: 'marker', marker_id: definition.id, check_id: check.id }, bundle, options, now, failures);
    }));
    const passedChecks = checks.filter(Boolean).length;
    results.push({
      id: definition.id,
      passed_checks: passedChecks,
      required_checks: 10,
      score: (10 * passedChecks) / definition.checks.length,
      mandatory_passed: definition.checks.every((check, index) => !check.mandatory || checks[index]),
    });
  }
  return results;
}

async function validateHardGates(
  bundle: ReleaseScorecardBundle,
  options: ScorecardValidationOptions,
  now: number | null,
  failures: Set<ScorecardFailureCode>,
): Promise<readonly string[]> {
  if (!hasExactStringIds(bundle.hard_gates, HARD_GATES)) failures.add('hard_gate_shape_invalid');
  const outcomes = await Promise.all(HARD_GATES.map(async (id) => {
    const matching = bundle.hard_gates.filter((gate) => gate.id === id);
    if (matching.length !== 1) return { id, passed: false };
    const hardGate = matching.at(0);
    if (hardGate === undefined) return { id, passed: false };
    const passed = await evidencePasses(hardGate.evidence, { kind: 'hard_gate', id }, bundle, options, now, failures);
    return { id, passed };
  }));
  return outcomes.filter((outcome) => !outcome.passed).map((outcome) => outcome.id);
}

async function evidencePasses(
  references: readonly EvidenceReference[],
  target: MachineEvidenceTarget,
  bundle: ReleaseScorecardBundle,
  options: ScorecardValidationOptions,
  now: number | null,
  failures: Set<ScorecardFailureCode>,
): Promise<boolean> {
  if (references.length === 0 || now === null) {
    failures.add('evidence_missing');
    return false;
  }
  const evidence = await Promise.all(references.map((reference) => loadEvidence(reference, options, failures)));
  return evidence.every((document) => document !== null && evidenceMatches(document, target, bundle, now, failures));
}

async function loadEvidence(
  reference: EvidenceReference,
  options: ScorecardValidationOptions,
  failures: Set<ScorecardFailureCode>,
): Promise<MachineEvidence | null> {
  let contents: string | null;
  try {
    contents = await options.readEvidence(reference.path);
  } catch (error) {
    if (error instanceof Error) {
      failures.add('evidence_missing');
      return null;
    }
    throw error;
  }
  if (contents === null) {
    failures.add('evidence_missing');
    return null;
  }
  if (sha256Hex(contents) !== reference.sha256) {
    failures.add('evidence_hash_mismatch');
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(contents);
    const evidence = parseMachineEvidence(parsed);
    if (evidence === null) failures.add('evidence_malformed');
    return evidence;
  } catch (error) {
    if (error instanceof SyntaxError) {
      failures.add('evidence_malformed');
      return null;
    }
    throw error;
  }
}

function evidenceMatches(
  evidence: MachineEvidence,
  target: MachineEvidenceTarget,
  bundle: ReleaseScorecardBundle,
  now: number,
  failures: Set<ScorecardFailureCode>,
): boolean {
  let valid = true;
  if (evidence.release_commit !== bundle.release_commit) {
    failures.add('evidence_commit_mismatch');
    valid = false;
  }
  if (evidence.environment !== bundle.environment) {
    failures.add('evidence_environment_mismatch');
    valid = false;
  }
  const capturedAt = parseTimestamp(evidence.captured_at, failures, 'evidence_malformed');
  if (capturedAt === null || !isFresh(capturedAt, now)) {
    failures.add('evidence_stale');
    valid = false;
  }
  const matches = evidence.results.filter((result) => targetEquals(result.target, target));
  if (matches.length !== 1) {
    failures.add('evidence_target_invalid');
    return false;
  }
  const match = matches.at(0);
  return valid && match !== undefined && match.outcome === 'passed';
}

function targetEquals(left: MachineEvidenceTarget, right: MachineEvidenceTarget): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'marker' && right.kind === 'marker') {
    return left.marker_id === right.marker_id && left.check_id === right.check_id;
  }
  return left.kind === 'hard_gate' && right.kind === 'hard_gate' && left.id === right.id;
}

function hasExactIds<T extends { readonly id: string }>(items: readonly T[], expected: readonly { readonly id: string }[]): boolean {
  return items.length === expected.length
    && new Set(items.map((item) => item.id)).size === expected.length
    && expected.every((item) => items.some((candidate) => candidate.id === item.id));
}

function hasExactStringIds<T extends { readonly id: string }>(items: readonly T[], expected: readonly string[]): boolean {
  return items.length === expected.length
    && new Set(items.map((item) => item.id)).size === expected.length
    && expected.every((id) => items.some((item) => item.id === id));
}

function parseTimestamp(
  value: string,
  failures: Set<ScorecardFailureCode>,
  failure: ScorecardFailureCode,
): number | null {
  if (!isTimestamp(value)) {
    failures.add(failure);
    return null;
  }
  return new Date(value).getTime();
}

function isFresh(capturedAt: number, now: number): boolean {
  return capturedAt <= now && now - capturedAt <= MAX_EVIDENCE_AGE_MS;
}

function noGo(
  failures: Set<ScorecardFailureCode>,
  failure: ScorecardFailureCode,
  bundle?: ReleaseScorecardBundle,
): ReleaseScorecardResult {
  failures.add(failure);
  return {
    schema_version: 1,
    release_commit: bundle?.release_commit ?? null,
    environment: bundle?.environment ?? null,
    markers: [],
    hard_gates: { passed: false, failures: [...HARD_GATES] },
    decision: 'no_go',
    failures: [...failures].sort(),
  };
}
