import {
  REQUIRED_INVARIANTS,
  REQUIRED_QUEUE_SCOPES,
  REQUIRED_ROW_SCOPES,
} from './report-contract.js';
import {
  ReportIssues,
  arrayAt,
  equal,
  isoTimeAt,
  record,
  recordAt,
  sha256At,
  statusAt,
  stringAt,
  wholeNumberAt,
  type JsonRecord,
} from './report-primitives.js';

type PairedField = readonly [source: string, target: string, kind: 'number' | 'sha256'];

export function validateComparisons(report: JsonRecord, issues: ReportIssues): void {
  validateMigrationHashes(report, issues);
  validateSchema(report, issues);
  validateNamedTotals(report, 'row_totals', 'table', REQUIRED_ROW_SCOPES, [], issues);
  validateNamedTotals(
    report,
    'identifier_comparisons',
    'entity',
    REQUIRED_ROW_SCOPES,
    [['source_id_sha256', 'target_id_sha256', 'sha256']],
    issues,
  );
  validateState(report, 'idempotency', [
    ['source_total', 'target_total', 'number'],
    ['source_key_sha256', 'target_key_sha256', 'sha256'],
    ['source_duplicate_total', 'target_duplicate_total', 'number'],
  ], issues);
  validateState(report, 'ledger', [
    ['source_total', 'target_total', 'number'],
    ['source_entry_sha256', 'target_entry_sha256', 'sha256'],
    ['source_debit_lamports', 'target_debit_lamports', 'number'],
    ['source_credit_lamports', 'target_credit_lamports', 'number'],
  ], issues);
  validateState(report, 'liability', [
    ['source_row_total', 'target_row_total', 'number'],
    ['source_id_sha256', 'target_id_sha256', 'sha256'],
    ['source_liability_lamports', 'target_liability_lamports', 'number'],
  ], issues);
  validateState(report, 'proofs', [
    ['source_row_total', 'target_row_total', 'number'],
    ['source_id_sha256', 'target_id_sha256', 'sha256'],
    ['source_pending_total', 'target_pending_total', 'number'],
    ['source_verified_total', 'target_verified_total', 'number'],
    ['source_failed_total', 'target_failed_total', 'number'],
    ['source_unavailable_total', 'target_unavailable_total', 'number'],
  ], issues);
  validateQueues(report, issues);
  validateInvariants(report, issues);
  validateWorkersAndDecision(report, issues);
}

function validateMigrationHashes(report: JsonRecord, issues: ReportIssues): void {
  const hashes = recordAt(report, 'migration_hashes', '$.migration_hashes', issues);
  if (hashes === undefined) return;
  const source = arrayAt(hashes, 'source', '$.migration_hashes.source', issues);
  const target = arrayAt(hashes, 'target', '$.migration_hashes.target', issues);
  if (source === undefined || target === undefined) return;
  if (source.length === 0) issues.add('$.migration_hashes.source', 'must not be empty');
  if (source.length !== target.length) issues.add('$.migration_hashes', 'source and target migration counts differ');
  const entries = Math.min(source.length, target.length);
  for (let index = 0; index < entries; index += 1) {
    const sourceEntry = record(source[index], `$.migration_hashes.source[${index}]`, issues);
    const targetEntry = record(target[index], `$.migration_hashes.target[${index}]`, issues);
    if (sourceEntry === undefined || targetEntry === undefined) continue;
    const sourceName = stringAt(sourceEntry, 'name', `$.migration_hashes.source[${index}].name`, issues);
    const targetName = stringAt(targetEntry, 'name', `$.migration_hashes.target[${index}].name`, issues);
    const sourceHash = sha256At(sourceEntry, 'sha256', `$.migration_hashes.source[${index}].sha256`, issues);
    const targetHash = sha256At(targetEntry, 'sha256', `$.migration_hashes.target[${index}].sha256`, issues);
    equal(sourceName, targetName, `$.migration_hashes[${index}].name`, issues);
    equal(sourceHash, targetHash, `$.migration_hashes[${index}].sha256`, issues);
  }
}

function validateSchema(report: JsonRecord, issues: ReportIssues): void {
  const schema = recordAt(report, 'schema', '$.schema', issues);
  if (schema === undefined) return;
  const source = sha256At(schema, 'source_checksum', '$.schema.source_checksum', issues);
  const target = sha256At(schema, 'target_checksum', '$.schema.target_checksum', issues);
  equal(source, target, '$.schema.checksum', issues);
  statusAt(schema, '$.schema', issues);
}

function validateNamedTotals(
  report: JsonRecord,
  field: string,
  nameKey: string,
  requiredNames: readonly string[],
  pairs: readonly PairedField[],
  issues: ReportIssues,
): void {
  const entries = arrayAt(report, field, `$.${field}`, issues);
  if (entries === undefined) return;
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const path = `$.${field}[${index}]`;
    const item = record(entry, path, issues);
    if (item === undefined) return;
    const name = stringAt(item, nameKey, `${path}.${nameKey}`, issues);
    if (name !== undefined) seen.add(name);
    validatePair(item, path, ['source_total', 'target_total', 'number'], issues);
    for (const pair of pairs) validatePair(item, path, pair, issues);
    statusAt(item, path, issues);
  });
  for (const name of requiredNames) {
    if (!seen.has(name)) issues.add(`$.${field}`, `missing required comparison for ${name}`);
  }
}

function validateState(
  report: JsonRecord,
  field: string,
  pairs: readonly PairedField[],
  issues: ReportIssues,
): void {
  const state = recordAt(report, field, `$.${field}`, issues);
  if (state === undefined) return;
  for (const pair of pairs) validatePair(state, `$.${field}`, pair, issues);
  statusAt(state, `$.${field}`, issues);
  if (field === 'idempotency') {
    const sourceDuplicates = wholeNumberAt(state, 'source_duplicate_total', '$.idempotency.source_duplicate_total', issues);
    const targetDuplicates = wholeNumberAt(state, 'target_duplicate_total', '$.idempotency.target_duplicate_total', issues);
    if (sourceDuplicates !== undefined && sourceDuplicates !== 0) issues.add('$.idempotency.source_duplicate_total', 'must equal zero');
    if (targetDuplicates !== undefined && targetDuplicates !== 0) issues.add('$.idempotency.target_duplicate_total', 'must equal zero');
  }
}

function validatePair(item: JsonRecord, path: string, pair: PairedField, issues: ReportIssues): void {
  const [sourceKey, targetKey, kind] = pair;
  const source = kind === 'number'
    ? wholeNumberAt(item, sourceKey, `${path}.${sourceKey}`, issues)
    : sha256At(item, sourceKey, `${path}.${sourceKey}`, issues);
  const target = kind === 'number'
    ? wholeNumberAt(item, targetKey, `${path}.${targetKey}`, issues)
    : sha256At(item, targetKey, `${path}.${targetKey}`, issues);
  equal(source, target, `${path}.${sourceKey}/${targetKey}`, issues);
}

function validateQueues(report: JsonRecord, issues: ReportIssues): void {
  const queues = arrayAt(report, 'queues', '$.queues', issues);
  if (queues === undefined) return;
  const seen = new Set<string>();
  queues.forEach((entry, index) => {
    const path = `$.queues[${index}]`;
    const queue = record(entry, path, issues);
    if (queue === undefined) return;
    const name = stringAt(queue, 'name', `${path}.name`, issues);
    if (name !== undefined) seen.add(name);
    const source = recordAt(queue, 'source', `${path}.source`, issues);
    const target = recordAt(queue, 'target', `${path}.target`, issues);
    if (source !== undefined && target !== undefined) {
      for (const key of ['ready_total', 'leased_total', 'dead_letter_total'] as const) {
        const left = wholeNumberAt(source, key, `${path}.source.${key}`, issues);
        const right = wholeNumberAt(target, key, `${path}.target.${key}`, issues);
        equal(left, right, `${path}.${key}`, issues);
      }
      const left = sha256At(source, 'job_id_sha256', `${path}.source.job_id_sha256`, issues);
      const right = sha256At(target, 'job_id_sha256', `${path}.target.job_id_sha256`, issues);
      equal(left, right, `${path}.job_id_sha256`, issues);
    }
    statusAt(queue, path, issues);
  });
  for (const queue of REQUIRED_QUEUE_SCOPES) {
    if (!seen.has(queue)) issues.add('$.queues', `missing required comparison for ${queue}`);
  }
}

function validateInvariants(report: JsonRecord, issues: ReportIssues): void {
  const invariants = arrayAt(report, 'invariants', '$.invariants', issues);
  if (invariants === undefined) return;
  const seen = new Set<string>();
  invariants.forEach((entry, index) => {
    const path = `$.invariants[${index}]`;
    const invariant = record(entry, path, issues);
    if (invariant === undefined) return;
    const name = stringAt(invariant, 'name', `${path}.name`, issues);
    if (name !== undefined) seen.add(name);
    if (stringAt(invariant, 'source', `${path}.source`, issues) !== 'pass') issues.add(`${path}.source`, 'must equal pass');
    if (stringAt(invariant, 'target', `${path}.target`, issues) !== 'pass') issues.add(`${path}.target`, 'must equal pass');
    statusAt(invariant, path, issues);
  });
  for (const invariant of REQUIRED_INVARIANTS) {
    if (!seen.has(invariant)) issues.add('$.invariants', `missing required invariant ${invariant}`);
  }
}

function validateWorkersAndDecision(report: JsonRecord, issues: ReportIssues): void {
  const reconciliation = recordAt(report, 'worker_reconciliation', '$.worker_reconciliation', issues);
  if (reconciliation !== undefined) {
    if (stringAt(reconciliation, 'status', '$.worker_reconciliation.status', issues) !== 'complete') {
      issues.add('$.worker_reconciliation.status', 'must equal complete');
    }
    validateNamedWorkers(reconciliation, issues);
  }
  const decision = recordAt(report, 'decision', '$.decision', issues);
  if (decision !== undefined) {
    stringAt(decision, 'owner', '$.decision.owner', issues);
    isoTimeAt(decision, 'deadline_at', '$.decision.deadline_at', issues);
    if (stringAt(decision, 'decision', '$.decision.decision', issues) !== 'accepted') {
      issues.add('$.decision.decision', 'must equal accepted');
    }
  }
}

function validateNamedWorkers(reconciliation: JsonRecord, issues: ReportIssues): void {
  const workers = arrayAt(reconciliation, 'workers', '$.worker_reconciliation.workers', issues);
  if (workers === undefined) return;
  const seen = new Set<string>();
  workers.forEach((entry, index) => {
    const path = `$.worker_reconciliation.workers[${index}]`;
    const worker = record(entry, path, issues);
    if (worker === undefined) return;
    const name = stringAt(worker, 'name', `${path}.name`, issues);
    if (name !== undefined) seen.add(name);
    if (stringAt(worker, 'status', `${path}.status`, issues) !== 'reconciled') issues.add(`${path}.status`, 'must equal reconciled');
    if (stringAt(worker, 'external_side_effects', `${path}.external_side_effects`, issues) !== 'blocked') {
      issues.add(`${path}.external_side_effects`, 'must equal blocked');
    }
  });
  for (const worker of REQUIRED_QUEUE_SCOPES) {
    if (!seen.has(worker)) issues.add('$.worker_reconciliation.workers', `missing required worker ${worker}`);
  }
}
