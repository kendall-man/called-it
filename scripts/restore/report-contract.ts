export const RESTORE_REPORT_SCHEMA_VERSION = 1;

export const REQUIRED_ROW_SCOPES = [
  'groups',
  'markets',
  'positions',
  'settlements',
  'ledger_entries',
  'proofs',
  'telegram_updates',
  'proof_submission_outbox',
] as const;

export const REQUIRED_QUEUE_SCOPES = [
  'telegram_ingress',
  'telegram_outbound',
  'settlement',
  'proof',
  'proof_submission',
] as const;

export const REQUIRED_INVARIANTS = [
  'no_duplicate_idempotency_keys',
  'ledger_append_only_and_balanced',
  'liability_reconciles',
  'proofs_immutable_and_verifiable',
  'queue_leases_recoverable',
] as const;

export const REQUIRED_WRITE_FLAGS = [
  'writes_enabled',
  'intake_enabled',
  'settlement_enabled',
  'proof_submission_enabled',
  'withdrawals_enabled',
] as const;

export type RestoreReportViolation = {
  readonly path: string;
  readonly message: string;
};

export type RestoreReportValidation =
  | { readonly kind: 'valid' }
  | { readonly kind: 'invalid'; readonly violations: readonly RestoreReportViolation[] };
