import { DbError } from './errors.js';
import type {
  SettlementProofJobErrorCode,
  SettlementProofJobKind,
  SettlementProofJobStatus,
  SettlementProofKind,
  SettlementProofRpcCode,
  SettlementProofState,
} from './settlement-proof-job-types.js';

export type SettlementProofRpcRow = Readonly<Record<string, unknown>>;

function isSettlementProofRpcRow(value: unknown): value is SettlementProofRpcRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function malformedSettlementProofRpc(op: string, field: string): never {
  throw new DbError(op, { message: `malformed RPC payload field: ${field}` });
}

export function settlementProofRecord(op: string, value: unknown): SettlementProofRpcRow {
  if (isSettlementProofRpcRow(value)) {
    return value;
  }
  return malformedSettlementProofRpc(op, '<row>');
}

export function settlementProofArray(op: string, value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  return malformedSettlementProofRpc(op, '<rows>');
}

export function settlementProofBoolean(op: string, row: SettlementProofRpcRow, field: string): boolean {
  const value = row[field];
  if (typeof value === 'boolean') return value;
  return malformedSettlementProofRpc(op, field);
}

export function settlementProofString(op: string, row: SettlementProofRpcRow, field: string): string {
  const value = row[field];
  if (typeof value === 'string') return value;
  return malformedSettlementProofRpc(op, field);
}

export function settlementProofNullableString(
  op: string,
  row: SettlementProofRpcRow,
  field: string,
): string | null {
  const value = row[field];
  if (value === null || typeof value === 'string') return value;
  return malformedSettlementProofRpc(op, field);
}

export function settlementProofInteger(op: string, row: SettlementProofRpcRow, field: string): number {
  const value = row[field];
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  return malformedSettlementProofRpc(op, field);
}

export function settlementProofNullableInteger(
  op: string,
  row: SettlementProofRpcRow,
  field: string,
): number | null {
  const value = row[field];
  if (value === null || (typeof value === 'number' && Number.isSafeInteger(value))) return value;
  return malformedSettlementProofRpc(op, field);
}

export function settlementProofTimestamp(op: string, value: string, field: string): string {
  if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value))
  ) {
    return value;
  }
  return malformedSettlementProofRpc(op, field);
}

export function settlementProofNullableTimestamp(
  op: string,
  row: SettlementProofRpcRow,
  field: string,
): string | null {
  const value = settlementProofNullableString(op, row, field);
  return value === null ? null : settlementProofTimestamp(op, value, field);
}

export function settlementProofUuid(op: string, value: string, field: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return value;
  }
  return malformedSettlementProofRpc(op, field);
}

export function parseSettlementProofJobKind(op: string, value: unknown): SettlementProofJobKind {
  switch (value) {
    case 'settlement':
    case 'proof':
      return value;
    default:
      return malformedSettlementProofRpc(op, 'job_kind');
  }
}

export function parseSettlementProofJobStatus(op: string, value: unknown): SettlementProofJobStatus {
  switch (value) {
    case 'pending':
    case 'leased':
    case 'retry_wait':
    case 'complete':
    case 'dead':
      return value;
    default:
      return malformedSettlementProofRpc(op, 'status');
  }
}

export function parseSettlementProofKind(op: string, value: unknown): SettlementProofKind {
  switch (value) {
    case 'stat':
    case 'odds':
      return value;
    default:
      return malformedSettlementProofRpc(op, 'kind');
  }
}

export function parseSettlementProofState(op: string, value: unknown): SettlementProofState {
  switch (value) {
    case 'pending':
    case 'verified':
    case 'failed':
    case 'unavailable':
      return value;
    default:
      return malformedSettlementProofRpc(op, 'status');
  }
}

export function parseSettlementProofRpcCode(op: string, value: unknown): SettlementProofRpcCode {
  switch (value) {
    case 'market_not_found':
    case 'market_not_sol':
    case 'market_not_terminal':
    case 'terminal_state_conflict':
    case 'tier_mismatch':
    case 'settlement_fact_missing':
    case 'settlement_fact_conflict':
    case 'proof_fact_conflict':
    case 'verified_shape_invalid':
    case 'invalid_job_kind':
    case 'invalid_queue_policy':
    case 'lease_lost':
    case 'effects_incomplete':
    case 'proof_terminal_missing':
      return value;
    default:
      return malformedSettlementProofRpc(op, 'code');
  }
}

export function parseSettlementProofJobErrorCode(
  op: string,
  value: string | null,
): SettlementProofJobErrorCode | null {
  if (value === null) return null;
  switch (value) {
    case 'database_unavailable':
    case 'settlement_fact_missing':
    case 'settlement_fact_conflict':
    case 'settlement_rederive_failed':
    case 'wager_apply_failed':
    case 'proof_enqueue_failed':
    case 'chat_delivery_failed':
    case 'chat_ownership_pending':
    case 'lease_expired':
    case 'unexpected_error':
    case 'proof_submission_disabled':
    case 'proof_fetch_failed':
    case 'proof_payload_invalid':
    case 'proof_submit_failed':
    case 'proof_verify_pending':
    case 'proof_verify_failed':
      return value;
    default:
      return malformedSettlementProofRpc(op, 'last_error_code');
  }
}
