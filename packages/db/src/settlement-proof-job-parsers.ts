import {
  malformedSettlementProofRpc,
  parseSettlementProofJobStatus,
  parseSettlementProofKind,
  parseSettlementProofRpcCode,
  parseSettlementProofState,
  settlementProofArray,
  settlementProofBoolean,
  settlementProofInteger,
  settlementProofNullableInteger,
  settlementProofNullableTimestamp,
  settlementProofRecord,
  settlementProofString,
  settlementProofTimestamp,
  settlementProofUuid,
} from './settlement-proof-job-parser-core.js';
import { parseSettlementProofJobRow } from './settlement-proof-job-row-parser.js';
import type {
  EnqueueSettlementProofJobResult,
  JobTransitionResult,
  RecordProofStateResult,
  RecordTerminalSettlementResult,
  ReconcileTerminalJobReason,
  ReconcileTerminalJobResult,
  SettlementPostedResult,
  SettlementProofBacklog,
  TerminalSettlementGap,
} from './settlement-proof-job-types.js';

export function parseRecordTerminalSettlement(
  op: string,
  value: unknown,
): RecordTerminalSettlementResult {
  const row = settlementProofRecord(op, value);
  if (row.ok === false) return { ok: false, code: parseSettlementProofRpcCode(op, row.code) };
  if (row.ok !== true) return malformedSettlementProofRpc(op, 'ok');
  return {
    ok: true,
    duplicate: settlementProofBoolean(op, row, 'duplicate'),
    marketId: settlementProofUuid(op, settlementProofString(op, row, 'market_id'), 'market_id'),
    jobStatus: parseSettlementProofJobStatus(op, row.job_status),
  };
}

export function parseSettlementPosted(op: string, value: unknown): SettlementPostedResult {
  const row = settlementProofRecord(op, value);
  if (row.ok === false) {
    const code = parseSettlementProofRpcCode(op, row.code);
    if (code !== 'settlement_fact_missing') return malformedSettlementProofRpc(op, 'code');
    return { ok: false, code };
  }
  if (row.ok !== true) return malformedSettlementProofRpc(op, 'ok');
  return {
    ok: true,
    duplicate: settlementProofBoolean(op, row, 'duplicate'),
    postedAt: settlementProofTimestamp(op, settlementProofString(op, row, 'posted_at'), 'posted_at'),
  };
}

export function parseRecordProofState(op: string, value: unknown): RecordProofStateResult {
  const row = settlementProofRecord(op, value);
  if (row.ok === false) return { ok: false, code: parseSettlementProofRpcCode(op, row.code) };
  if (row.ok !== true) return malformedSettlementProofRpc(op, 'ok');
  const status = parseSettlementProofState(op, row.status);
  const verifiedAt = settlementProofNullableTimestamp(op, row, 'verified_at');
  if ((status === 'verified') !== (verifiedAt !== null)) {
    return malformedSettlementProofRpc(op, 'verified_at');
  }
  return {
    ok: true,
    duplicate: settlementProofBoolean(op, row, 'duplicate'),
    marketId: settlementProofUuid(op, settlementProofString(op, row, 'market_id'), 'market_id'),
    kind: parseSettlementProofKind(op, row.kind),
    status,
    verifiedAt,
  };
}

export function parseEnqueueSettlementProofJob(
  op: string,
  value: unknown,
): EnqueueSettlementProofJobResult {
  const row = settlementProofRecord(op, value);
  if (row.ok === false) return { ok: false, code: parseSettlementProofRpcCode(op, row.code) };
  if (row.ok !== true) return malformedSettlementProofRpc(op, 'ok');
  return {
    ok: true,
    created: settlementProofBoolean(op, row, 'created'),
    job: parseSettlementProofJobRow(op, row.job),
  };
}

export function parseJobTransition(op: string, value: unknown): JobTransitionResult {
  const row = settlementProofRecord(op, value);
  if (row.ok === false) return { ok: false, code: parseSettlementProofRpcCode(op, row.code) };
  if (row.ok !== true) return malformedSettlementProofRpc(op, 'ok');
  const status = parseSettlementProofJobStatus(op, row.status);
  if (status !== 'retry_wait' && status !== 'complete' && status !== 'dead') {
    return malformedSettlementProofRpc(op, 'status');
  }
  return { ok: true, status, duplicate: settlementProofBoolean(op, row, 'duplicate') };
}

export function parseLeaseJobs(op: string, value: unknown): readonly ReturnType<typeof parseSettlementProofJobRow>[] {
  return settlementProofArray(op, value).map((row) => {
    const job = parseSettlementProofJobRow(op, row);
    if (job.status !== 'leased') return malformedSettlementProofRpc(op, 'status');
    return job;
  });
}

export function parseTerminalGaps(op: string, value: unknown): readonly TerminalSettlementGap[] {
  return settlementProofArray(op, value).map((valueRow) => {
    const row = settlementProofRecord(op, valueRow);
    return {
      marketId: settlementProofUuid(op, settlementProofString(op, row, 'market_id'), 'market_id'),
      settlementJobMissing: settlementProofBoolean(op, row, 'settlement_job_missing'),
      settlementRowMissing: settlementProofBoolean(op, row, 'settlement_row_missing'),
      wagerMarkerMissing: settlementProofBoolean(op, row, 'wager_marker_missing'),
      proofJobMissing: settlementProofBoolean(op, row, 'proof_job_missing'),
      proofTerminalMissing: settlementProofBoolean(op, row, 'proof_terminal_missing'),
      chatPostMissing: settlementProofBoolean(op, row, 'chat_post_missing'),
      settlementTerminalConflict: settlementProofBoolean(op, row, 'settlement_terminal_conflict'),
      proofTerminalConflict: settlementProofBoolean(op, row, 'proof_terminal_conflict'),
    };
  });
}

export function parseReconcileTerminalJobs(op: string, value: unknown): readonly ReconcileTerminalJobResult[] {
  return settlementProofArray(op, value).map((valueRow) => {
    const row = settlementProofRecord(op, valueRow);
    const rawReasons = settlementProofArray(op, row.reason_codes);
    return {
      marketId: settlementProofUuid(op, settlementProofString(op, row, 'market_id'), 'market_id'),
      reasonCodes: rawReasons.map((reason) => parseReconcileReason(op, reason)),
      settlementJobCreated: settlementProofBoolean(op, row, 'settlement_job_created'),
      proofJobCreated: settlementProofBoolean(op, row, 'proof_job_created'),
    };
  });
}

export function parseSettlementProofBacklog(op: string, value: unknown): SettlementProofBacklog {
  const row = settlementProofRecord(op, value);
  const readyCount = positiveCount(op, row, 'ready_count');
  const oldestReadyAgeMs = settlementProofNullableInteger(op, row, 'oldest_ready_age_ms');
  if ((readyCount === 0) !== (oldestReadyAgeMs === null) || (oldestReadyAgeMs !== null && oldestReadyAgeMs < 0)) {
    return malformedSettlementProofRpc(op, 'oldest_ready_age_ms');
  }
  return {
    readyCount,
    oldestReadyAgeMs,
    activeLeaseCount: positiveCount(op, row, 'active_lease_count'),
    retryWaitCount: positiveCount(op, row, 'retry_wait_count'),
    expiredLeaseCount: positiveCount(op, row, 'expired_lease_count'),
    deadCount: positiveCount(op, row, 'dead_count'),
  };
}

function parseReconcileReason(op: string, value: unknown): ReconcileTerminalJobReason {
  switch (value) {
    case 'settlement_job_missing':
    case 'settlement_fact_missing':
    case 'proof_job_missing':
    case 'settlement_terminal_conflict':
    case 'proof_terminal_conflict':
      return value;
    default:
      return malformedSettlementProofRpc(op, 'reason_codes');
  }
}

function positiveCount(op: string, row: Readonly<Record<string, unknown>>, field: string): number {
  const value = settlementProofInteger(op, row, field);
  if (value >= 0) return value;
  return malformedSettlementProofRpc(op, field);
}
