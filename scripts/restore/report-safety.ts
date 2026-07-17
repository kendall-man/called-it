import {
  REQUIRED_WRITE_FLAGS,
  RESTORE_REPORT_SCHEMA_VERSION,
} from './report-contract.js';
import {
  ReportIssues,
  arrayAt,
  booleanAt,
  isoTimeAt,
  isRecord,
  recordAt,
  stringAt,
  wholeNumberAt,
  type JsonRecord,
} from './report-primitives.js';

const REDACTED_VALUE = /^(?:\[REDACTED\]|redacted:)/i;
const SECRET_FIELD = /(?:^|[_-])(?:secret|token|password|api[_-]?key|private[_-]?key|access[_-]?key|authorization|connection[_-]?string|database[_-]?url)(?:$|[_-])/i;
const RAW_SECRET = /(?:postgres(?:ql)?:\/\/|https?:\/\/[^/\s:@]+:[^@/\s]+@|\bBearer\s+\S+|-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----|\b(?:sk|pk|xox)[_-][A-Za-z0-9_-]{8,})/i;
const REVERSE_MIGRATION = /\b(?:reverse|down|rollback)\s+(?:the\s+)?(?:database\s+)?migrations?\b/i;

export function validateSafetyAndRollback(report: JsonRecord, issues: ReportIssues): void {
  validateIdentity(report, issues);
  validateIsolation(report, issues);
  validateTiming(report, issues);
  validateProviderEvidence(report, issues);
  validateSafeState(report, issues);
  validateAppRollback(report, issues);
  scanSensitiveAndReverseInstructions(report, '$', issues);
}

function validateIdentity(report: JsonRecord, issues: ReportIssues): void {
  const schemaVersion = wholeNumberAt(report, 'schema_version', '$.schema_version', issues);
  if (schemaVersion !== undefined && schemaVersion !== RESTORE_REPORT_SCHEMA_VERSION) {
    issues.add('$.schema_version', `must equal ${RESTORE_REPORT_SCHEMA_VERSION}`);
  }
  stringAt(report, 'report_id', '$.report_id', issues);
  const redaction = recordAt(report, 'redaction', '$.redaction', issues);
  if (redaction !== undefined && stringAt(redaction, 'status', '$.redaction.status', issues) !== 'redacted') {
    issues.add('$.redaction.status', 'must equal redacted');
  }
  const source = recordAt(report, 'source', '$.source', issues);
  if (source !== undefined) {
    if (stringAt(source, 'classification', '$.source.classification', issues) !== 'production') {
      issues.add('$.source.classification', 'must equal production');
    }
    requireRedacted(source, 'reference', '$.source.reference', issues);
  }
}

function validateIsolation(report: JsonRecord, issues: ReportIssues): void {
  const target = recordAt(report, 'target', '$.target', issues);
  if (target === undefined) return;
  if (stringAt(target, 'classification', '$.target.classification', issues) !== 'isolated_restore') {
    issues.add('$.target.classification', 'must equal isolated_restore');
  }
  requireRedacted(target, 'reference', '$.target.reference', issues);
  requireBoolean(target, 'is_isolated', true, '$.target.is_isolated', issues);
  requireBoolean(target, 'is_live', false, '$.target.is_live', issues);
  requireBoolean(target, 'independent_project', true, '$.target.independent_project', issues);
  requireBoolean(target, 'production_credentials_attached', false, '$.target.production_credentials_attached', issues);
  requireString(target, 'external_delivery', 'blocked', '$.target.external_delivery', issues);
}

function validateTiming(report: JsonRecord, issues: ReportIssues): void {
  const timing = recordAt(report, 'timing', '$.timing', issues);
  if (timing === undefined) return;
  const source = isoTimeAt(timing, 'source_last_consistent_at', '$.timing.source_last_consistent_at', issues);
  const start = isoTimeAt(timing, 'restore_started_at', '$.timing.restore_started_at', issues);
  const complete = isoTimeAt(timing, 'recovery_completed_at', '$.timing.recovery_completed_at', issues);
  const rpo = wholeNumberAt(timing, 'rpo_minutes', '$.timing.rpo_minutes', issues);
  const rto = wholeNumberAt(timing, 'rto_minutes', '$.timing.rto_minutes', issues);
  if (source !== undefined && start !== undefined && complete !== undefined) {
    if (source > start || start > complete) issues.add('$.timing', 'timestamps must be chronological');
    validateMeasuredTiming('rpo_minutes', (start - source) / 60_000, rpo, 15, issues);
    validateMeasuredTiming('rto_minutes', (complete - start) / 60_000, rto, 60, issues);
  }
}

function validateProviderEvidence(report: JsonRecord, issues: ReportIssues): void {
  const evidence = recordAt(report, 'provider_restore_evidence', '$.provider_restore_evidence', issues);
  if (evidence === undefined) return;
  requireString(evidence, 'execution', 'external_credential', '$.provider_restore_evidence.execution', issues);
  requireString(evidence, 'result', 'completed', '$.provider_restore_evidence.result', issues);
  stringAt(evidence, 'provider', '$.provider_restore_evidence.provider', issues);
  stringAt(evidence, 'evidence_reference', '$.provider_restore_evidence.evidence_reference', issues);
  isoTimeAt(evidence, 'observed_at', '$.provider_restore_evidence.observed_at', issues);
}

function validateSafeState(report: JsonRecord, issues: ReportIssues): void {
  const safeState = recordAt(report, 'safe_state', '$.safe_state', issues);
  if (safeState === undefined) return;
  const flags = recordAt(safeState, 'feature_flags', '$.safe_state.feature_flags', issues);
  if (flags !== undefined) {
    for (const flag of REQUIRED_WRITE_FLAGS) {
      const value = booleanAt(flags, flag, `$.safe_state.feature_flags.${flag}`, issues);
      if (value === true) issues.add(`$.safe_state.feature_flags.${flag}`, 'must be false before rollback or restore');
    }
  }
  const webhook = recordAt(safeState, 'webhook', '$.safe_state.webhook', issues);
  if (webhook !== undefined) {
    requireString(webhook, 'production_delivery', 'disabled', '$.safe_state.webhook.production_delivery', issues);
    requireString(webhook, 'isolated_target_registration', 'absent', '$.safe_state.webhook.isolated_target_registration', issues);
    requireString(webhook, 'pending_update_disposition', 'preserved', '$.safe_state.webhook.pending_update_disposition', issues);
  }
  requireString(safeState, 'external_side_effects', 'blocked', '$.safe_state.external_side_effects', issues);
}

function validateAppRollback(report: JsonRecord, issues: ReportIssues): void {
  const rollback = recordAt(report, 'app_rollback', '$.app_rollback', issues);
  if (rollback === undefined) return;
  requireString(rollback, 'mode', 'forward_only', '$.app_rollback.mode', issues);
  requireString(rollback, 'schema_action', 'none', '$.app_rollback.schema_action', issues);
  requireBoolean(rollback, 'flags_disabled_before_deploy', true, '$.app_rollback.flags_disabled_before_deploy', issues);
  const compatible = booleanAt(
    rollback,
    'release_compatible_with_enabled_flags',
    '$.app_rollback.release_compatible_with_enabled_flags',
    issues,
  );
  const flags = recordAt(report, 'safe_state', '$.safe_state', issues);
  const flagValues = flags === undefined ? undefined : recordAt(flags, 'feature_flags', '$.safe_state.feature_flags', issues);
  const enabled = flagValues === undefined ? false : REQUIRED_WRITE_FLAGS.some((flag) => flagValues[flag] === true);
  if (enabled && compatible !== true) {
    issues.add('$.app_rollback', 'cannot deploy an app incompatible with enabled feature flags');
  }
  const instructions = arrayAt(rollback, 'instructions', '$.app_rollback.instructions', issues);
  if (instructions !== undefined) {
    if (instructions.length === 0) issues.add('$.app_rollback.instructions', 'must not be empty');
    instructions.forEach((instruction, index) => {
      if (typeof instruction !== 'string' || instruction.length === 0) {
        issues.add(`$.app_rollback.instructions[${index}]`, 'must be a non-empty string');
      }
    });
  }
}

function validateMeasuredTiming(
  name: string,
  measured: number,
  reported: number | undefined,
  limit: number,
  issues: ReportIssues,
): void {
  if (measured > limit) issues.add(`$.timing.${name}`, `measured value exceeds ${limit} minutes`);
  if (reported !== undefined && Math.abs(measured - reported) > 0.001) {
    issues.add(`$.timing.${name}`, 'does not equal the measured duration');
  }
}

function requireRedacted(parent: JsonRecord, key: string, path: string, issues: ReportIssues): void {
  const value = stringAt(parent, key, path, issues);
  if (value !== undefined && !REDACTED_VALUE.test(value)) issues.add(path, 'must be redacted');
}

function requireString(parent: JsonRecord, key: string, expected: string, path: string, issues: ReportIssues): void {
  const value = stringAt(parent, key, path, issues);
  if (value !== undefined && value !== expected) issues.add(path, `must equal ${expected}`);
}

function requireBoolean(parent: JsonRecord, key: string, expected: boolean, path: string, issues: ReportIssues): void {
  const value = booleanAt(parent, key, path, issues);
  if (value !== undefined && value !== expected) issues.add(path, `must equal ${String(expected)}`);
}

function scanSensitiveAndReverseInstructions(value: unknown, path: string, issues: ReportIssues): void {
  if (typeof value === 'string') {
    if (RAW_SECRET.test(value) && !REDACTED_VALUE.test(value)) issues.add(path, 'contains unredacted secret-like material');
    if (REVERSE_MIGRATION.test(value)) issues.add(path, 'contains a reverse migration instruction');
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanSensitiveAndReverseInstructions(entry, `${path}[${index}]`, issues));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    const entryPath = `${path}.${key}`;
    if (SECRET_FIELD.test(key) && !(typeof entry === 'string' && REDACTED_VALUE.test(entry))) {
      issues.add(entryPath, 'secret-like field must contain only a redacted value');
    }
    scanSensitiveAndReverseInstructions(entry, entryPath, issues);
  }
}
