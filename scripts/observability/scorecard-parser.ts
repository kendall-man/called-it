import type {
  EvidenceReference,
  HardGateInput,
  MachineEvidence,
  MachineEvidenceResult,
  MachineEvidenceTarget,
  ReleaseScorecardBundle,
  ScorecardCheckInput,
  ScorecardMarkerInput,
} from './scorecard-types.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const SAFE_PATH_PATTERN = /^(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9][a-zA-Z0-9._/-]{0,239}$/u;
const ID_PATTERN = /^[a-z][a-z0-9_]{2,119}$/u;
const COMMAND_PATTERN = /^[a-z][a-z0-9_.-]{2,119}$/u;
const REASON_CODES = ['check_failed', 'hard_gate_failed', 'not_run'] as const;

export function parseReleaseScorecardBundle(value: unknown): ReleaseScorecardBundle | null {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'schema_version', 'release_commit', 'environment', 'created_at', 'markers', 'hard_gates',
  ])) return null;

  const schemaVersion = value.schema_version;
  const releaseCommit = value.release_commit;
  const environment = value.environment;
  const createdAt = value.created_at;
  const markers = parseMarkers(value.markers);
  const hardGates = parseHardGates(value.hard_gates);
  if (schemaVersion !== 1 || !isCommit(releaseCommit) || !isEnvironment(environment)
    || !isTimestamp(createdAt) || markers === null || hardGates === null) return null;
  return {
    schema_version: 1,
    release_commit: releaseCommit,
    environment,
    created_at: createdAt,
    markers,
    hard_gates: hardGates,
  };
}

export function parseMachineEvidence(value: unknown): MachineEvidence | null {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'schema_version', 'kind', 'release_commit', 'environment', 'captured_at', 'results',
  ])) return null;

  const schemaVersion = value.schema_version;
  const kind = value.kind;
  const releaseCommit = value.release_commit;
  const environment = value.environment;
  const capturedAt = value.captured_at;
  const results = parseMachineResults(value.results);
  if (schemaVersion !== 1 || kind !== 'calledit.machine_evidence' || !isCommit(releaseCommit)
    || !isEnvironment(environment) || !isTimestamp(capturedAt) || results === null) return null;
  return {
    schema_version: 1,
    kind: 'calledit.machine_evidence',
    release_commit: releaseCommit,
    environment,
    captured_at: capturedAt,
    results,
  };
}

export function isCommit(value: unknown): value is string {
  return typeof value === 'string' && COMMIT_PATTERN.test(value);
}

export function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function parseMarkers(value: unknown): readonly ScorecardMarkerInput[] | null {
  if (!Array.isArray(value)) return null;
  const markers: ScorecardMarkerInput[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, ['id', 'checks'])) return null;
    const id = candidate.id;
    const checks = parseChecks(candidate.checks);
    if (!isId(id) || checks === null) return null;
    markers.push({ id, checks });
  }
  return markers;
}

function parseChecks(value: unknown): readonly ScorecardCheckInput[] | null {
  if (!Array.isArray(value)) return null;
  const checks: ScorecardCheckInput[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, ['id', 'evidence'])) return null;
    const id = candidate.id;
    const evidence = parseEvidenceReferences(candidate.evidence);
    if (!isId(id) || evidence === null) return null;
    checks.push({ id, evidence });
  }
  return checks;
}

function parseHardGates(value: unknown): readonly HardGateInput[] | null {
  if (!Array.isArray(value)) return null;
  const hardGates: HardGateInput[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, ['id', 'evidence'])) return null;
    const id = candidate.id;
    const evidence = parseEvidenceReferences(candidate.evidence);
    if (!isId(id) || evidence === null) return null;
    hardGates.push({ id, evidence });
  }
  return hardGates;
}

function parseEvidenceReferences(value: unknown): readonly EvidenceReference[] | null {
  if (!Array.isArray(value)) return null;
  const references: EvidenceReference[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, ['path', 'sha256'])) return null;
    const path = candidate.path;
    const sha256 = candidate.sha256;
    if (!isSafePath(path) || !isSha256(sha256)) return null;
    references.push({ path, sha256 });
  }
  return references;
}

function parseMachineResults(value: unknown): readonly MachineEvidenceResult[] | null {
  if (!Array.isArray(value)) return null;
  const results: MachineEvidenceResult[] = [];
  for (const candidate of value) {
    const parsed = parseMachineResult(candidate);
    if (parsed === null) return null;
    results.push(parsed);
  }
  return results;
}

function parseMachineResult(value: unknown): MachineEvidenceResult | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['target', 'outcome', 'command_id', 'reason_code'])) return null;
  const target = parseMachineTarget(value.target);
  const outcome = value.outcome;
  const commandId = value.command_id;
  const reasonCode = value.reason_code;
  if (target === null || (outcome !== 'passed' && outcome !== 'failed') || !isCommand(commandId)) return null;
  if (reasonCode === undefined) return { target, outcome, command_id: commandId };
  if (!isReasonCode(reasonCode)) return null;
  return { target, outcome, command_id: commandId, reason_code: reasonCode };
}

function parseMachineTarget(value: unknown): MachineEvidenceTarget | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  if (value.kind === 'marker') {
    if (!hasOnlyKeys(value, ['kind', 'marker_id', 'check_id']) || !isId(value.marker_id)
      || !isId(value.check_id)) return null;
    return { kind: 'marker', marker_id: value.marker_id, check_id: value.check_id };
  }
  if (value.kind === 'hard_gate') {
    if (!hasOnlyKeys(value, ['kind', 'id']) || !isId(value.id)) return null;
    return { kind: 'hard_gate', id: value.id };
  }
  return null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

function isSafePath(value: unknown): value is string {
  return typeof value === 'string' && SAFE_PATH_PATTERN.test(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isCommand(value: unknown): value is string {
  return typeof value === 'string' && COMMAND_PATTERN.test(value);
}

function isReasonCode(value: unknown): value is MachineEvidenceResult['reason_code'] {
  return typeof value === 'string' && REASON_CODES.some((reasonCode) => reasonCode === value);
}

function isEnvironment(value: unknown): value is string {
  return typeof value === 'string' && /^(?:development|staging|production-canary)$/u.test(value);
}
