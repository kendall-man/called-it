import {
  malformedSettlementProofRpc,
  parseSettlementProofJobErrorCode,
  parseSettlementProofJobKind,
  parseSettlementProofJobStatus,
  settlementProofInteger,
  settlementProofNullableString,
  settlementProofNullableTimestamp,
  settlementProofRecord,
  settlementProofString,
  settlementProofTimestamp,
  settlementProofUuid,
} from './settlement-proof-job-parser-core.js';
import type {
  SettlementProofJobErrorCode,
  SettlementProofJobRow,
  SettlementProofJobStatus,
} from './settlement-proof-job-types.js';

export function parseSettlementProofJobRow(op: string, value: unknown): SettlementProofJobRow {
  const row = settlementProofRecord(op, value);
  const marketId = settlementProofUuid(op, settlementProofString(op, row, 'market_id'), 'market_id');
  const jobKind = parseSettlementProofJobKind(op, row.job_kind);
  const status = parseSettlementProofJobStatus(op, row.status);
  const attempts = settlementProofInteger(op, row, 'attempts');
  const maxAttempts = settlementProofInteger(op, row, 'max_attempts');
  const leaseMs = settlementProofInteger(op, row, 'lease_ms');
  const retryBaseMs = settlementProofInteger(op, row, 'retry_base_ms');
  const retryMaxMs = settlementProofInteger(op, row, 'retry_max_ms');
  const dueAt = settlementProofTimestamp(op, settlementProofString(op, row, 'due_at'), 'due_at');
  const leaseOwner = settlementProofNullableString(op, row, 'lease_owner');
  const leaseToken = settlementProofNullableString(op, row, 'lease_token');
  const leasedAt = settlementProofNullableTimestamp(op, row, 'leased_at');
  const leaseExpiresAt = settlementProofNullableTimestamp(op, row, 'lease_expires_at');
  const lastErrorCode = parseSettlementProofJobErrorCode(op, settlementProofNullableString(op, row, 'last_error_code'));
  const createdAt = settlementProofTimestamp(op, settlementProofString(op, row, 'created_at'), 'created_at');
  const updatedAt = settlementProofTimestamp(op, settlementProofString(op, row, 'updated_at'), 'updated_at');
  const completedAt = settlementProofNullableTimestamp(op, row, 'completed_at');
  const deadAt = settlementProofNullableTimestamp(op, row, 'dead_at');

  if (
    attempts < 0
    || attempts > maxAttempts
    || maxAttempts < 1
    || maxAttempts > 100
    || leaseMs < 1000
    || leaseMs > 900_000
    || retryBaseMs < 1
    || retryMaxMs < retryBaseMs
    || Date.parse(updatedAt) < Date.parse(createdAt)
  ) {
    return malformedSettlementProofRpc(op, 'job_policy');
  }

  assertSettlementProofJobShape(op, {
    status,
    attempts,
    leaseOwner,
    leaseToken,
    leasedAt,
    leaseExpiresAt,
    lastErrorCode,
    completedAt,
    deadAt,
  });

  return {
    marketId,
    jobKind,
    status,
    attempts,
    maxAttempts,
    leaseMs,
    retryBaseMs,
    retryMaxMs,
    dueAt,
    leaseOwner,
    leaseToken,
    leasedAt,
    leaseExpiresAt,
    lastErrorCode,
    createdAt,
    updatedAt,
    completedAt,
    deadAt,
  };
}

function assertSettlementProofJobShape(
  op: string,
  value: {
    readonly status: SettlementProofJobStatus;
    readonly attempts: number;
    readonly leaseOwner: string | null;
    readonly leaseToken: string | null;
    readonly leasedAt: string | null;
    readonly leaseExpiresAt: string | null;
    readonly lastErrorCode: SettlementProofJobErrorCode | null;
    readonly completedAt: string | null;
    readonly deadAt: string | null;
  },
): void {
  const hasLease = value.leaseOwner !== null
    && value.leaseToken !== null
    && value.leasedAt !== null
    && value.leaseExpiresAt !== null;
  if (hasLease) {
    settlementProofUuid(op, value.leaseToken, 'lease_token');
    if (value.leaseOwner.trim() === '' || value.leaseOwner.length > 128 || Date.parse(value.leaseExpiresAt) <= Date.parse(value.leasedAt)) {
      return malformedSettlementProofRpc(op, 'lease');
    }
  }

  switch (value.status) {
    case 'pending':
      if (value.attempts === 0 && !hasLease && value.lastErrorCode === null && value.completedAt === null && value.deadAt === null) return;
      return malformedSettlementProofRpc(op, 'pending_shape');
    case 'leased':
      if (value.attempts >= 1 && hasLease && value.completedAt === null && value.deadAt === null) return;
      return malformedSettlementProofRpc(op, 'leased_shape');
    case 'retry_wait':
      if (value.attempts >= 1 && hasLease && value.lastErrorCode !== null && value.completedAt === null && value.deadAt === null) return;
      return malformedSettlementProofRpc(op, 'retry_wait_shape');
    case 'complete':
      if (value.attempts >= 1 && hasLease && value.lastErrorCode === null && value.completedAt !== null && value.deadAt === null) return;
      return malformedSettlementProofRpc(op, 'complete_shape');
    case 'dead':
      if (value.attempts >= 1 && hasLease && value.lastErrorCode !== null && value.completedAt === null && value.deadAt !== null) return;
      return malformedSettlementProofRpc(op, 'dead_shape');
  }
}
