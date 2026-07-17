export function validRestoreReport(): Record<string, unknown> {
  return {
    schema_version: 1,
    report_id: 'restore-rehearsal-20260711-001',
    redaction: { status: 'redacted' },
    source: { classification: 'production', reference: '[REDACTED]' },
    target: {
      classification: 'isolated_restore',
      reference: '[REDACTED]',
      is_isolated: true,
      is_live: false,
      independent_project: true,
      production_credentials_attached: false,
      external_delivery: 'blocked',
    },
    timing: {
      source_last_consistent_at: '2026-07-11T09:50:00.000Z',
      restore_started_at: '2026-07-11T10:00:00.000Z',
      recovery_completed_at: '2026-07-11T10:40:00.000Z',
      rpo_minutes: 10,
      rto_minutes: 40,
    },
    provider_restore_evidence: {
      execution: 'external_credential',
      result: 'completed',
      provider: 'managed-postgres',
      evidence_reference: 'ticket:restore-20260711-001',
      observed_at: '2026-07-11T10:05:00.000Z',
    },
    safe_state: {
      feature_flags: {
        writes_enabled: false,
        intake_enabled: false,
        settlement_enabled: false,
        proof_submission_enabled: false,
        withdrawals_enabled: false,
      },
      webhook: {
        production_delivery: 'disabled',
        isolated_target_registration: 'absent',
        pending_update_disposition: 'preserved',
      },
      external_side_effects: 'blocked',
    },
    app_rollback: {
      mode: 'forward_only',
      schema_action: 'none',
      flags_disabled_before_deploy: true,
      release_compatible_with_enabled_flags: false,
      instructions: ['Deploy the prior compatible application release with write paths disabled.'],
    },
    migration_hashes: {
      source: [{ name: '0001_init.sql', sha256: 'a'.repeat(64) }],
      target: [{ name: '0001_init.sql', sha256: 'a'.repeat(64) }],
    },
    schema: {
      source_checksum: 'b'.repeat(64),
      target_checksum: 'b'.repeat(64),
      status: 'match',
    },
    row_totals: comparisonRows(),
    identifier_comparisons: identifierComparisons(),
    idempotency: pairedState({
      source_total: 19,
      target_total: 19,
      source_key_sha256: 'c'.repeat(64),
      target_key_sha256: 'c'.repeat(64),
      source_duplicate_total: 0,
      target_duplicate_total: 0,
    }),
    ledger: pairedState({
      source_total: 20,
      target_total: 20,
      source_entry_sha256: 'd'.repeat(64),
      target_entry_sha256: 'd'.repeat(64),
      source_debit_lamports: 100,
      target_debit_lamports: 100,
      source_credit_lamports: 100,
      target_credit_lamports: 100,
    }),
    liability: pairedState({
      source_row_total: 3,
      target_row_total: 3,
      source_id_sha256: 'e'.repeat(64),
      target_id_sha256: 'e'.repeat(64),
      source_liability_lamports: 50,
      target_liability_lamports: 50,
    }),
    proofs: pairedState({
      source_row_total: 2,
      target_row_total: 2,
      source_id_sha256: 'f'.repeat(64),
      target_id_sha256: 'f'.repeat(64),
      source_pending_total: 1,
      target_pending_total: 1,
      source_verified_total: 1,
      target_verified_total: 1,
      source_failed_total: 0,
      target_failed_total: 0,
      source_unavailable_total: 0,
      target_unavailable_total: 0,
    }),
    queues: queueComparisons(),
    invariants: invariantComparisons(),
    worker_reconciliation: {
      status: 'complete',
      workers: ['telegram_ingress', 'telegram_outbound', 'settlement', 'proof', 'proof_submission'].map(
        (name) => ({ name, status: 'reconciled', external_side_effects: 'blocked' }),
      ),
    },
    decision: {
      owner: 'incident-commander',
      deadline_at: '2026-07-11T11:00:00.000Z',
      decision: 'accepted',
    },
  };
}

const REQUIRED_ROWS = [
  'groups',
  'markets',
  'positions',
  'settlements',
  'ledger_entries',
  'proofs',
  'telegram_updates',
  'proof_submission_outbox',
] as const;

const REQUIRED_QUEUES = [
  'telegram_ingress',
  'telegram_outbound',
  'settlement',
  'proof',
  'proof_submission',
] as const;

function comparisonRows(): readonly Record<string, unknown>[] {
  return REQUIRED_ROWS.map((table) => ({
    table,
    source_total: 1,
    target_total: 1,
    status: 'match',
  }));
}

function identifierComparisons(): readonly Record<string, unknown>[] {
  return REQUIRED_ROWS.map((entity) => ({
    entity,
    source_total: 1,
    target_total: 1,
    source_id_sha256: '1'.repeat(64),
    target_id_sha256: '1'.repeat(64),
    status: 'match',
  }));
}

function queueComparisons(): readonly Record<string, unknown>[] {
  return REQUIRED_QUEUES.map((name) => ({
    name,
    source: { ready_total: 0, leased_total: 0, dead_letter_total: 0, job_id_sha256: '2'.repeat(64) },
    target: { ready_total: 0, leased_total: 0, dead_letter_total: 0, job_id_sha256: '2'.repeat(64) },
    status: 'match',
  }));
}

function invariantComparisons(): readonly Record<string, unknown>[] {
  return [
    'no_duplicate_idempotency_keys',
    'ledger_append_only_and_balanced',
    'liability_reconciles',
    'proofs_immutable_and_verifiable',
    'queue_leases_recoverable',
  ].map((name) => ({ name, source: 'pass', target: 'pass', status: 'match' }));
}

function pairedState(value: Record<string, unknown>): Record<string, unknown> {
  return { ...value, status: 'match' };
}
