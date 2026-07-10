import {
  arrayField,
  booleanField,
  integerField,
  isUuid,
  isWorkerKind,
  nullableStringField,
  record,
  stringField,
} from './telegram-db-core.js';
import { malformedTelegramRpcResponse } from './telegram-db-rpc-response.js';
import type {
  TelegramDeliverySnapshot,
  TelegramPruneDeliveryResult,
  TelegramWorkerHeartbeatSnapshot,
} from './telegram-types.js';

export function parseHeartbeat(op: string, payload: unknown): void {
  const row = record(op, payload);
  if (booleanField(op, row, 'ok')) {
    return;
  }
  return malformedTelegramRpcResponse(op);
}

export function parseSnapshot(op: string, payload: unknown): TelegramDeliverySnapshot {
  const row = record(op, payload);
  if (!booleanField(op, row, 'ok')) {
    return malformedTelegramRpcResponse(op);
  }
  return {
    ok: true,
    observedAt: stringField(op, row, 'observed_at'),
    ingressActiveCount: integerField(op, row, 'ingress_active_count'),
    ingressDeadCount: integerField(op, row, 'ingress_dead_count'),
    ingressOldestAgeMs: nullableIntegerField(op, row, 'ingress_oldest_age_ms'),
    outboundUncertainCount: integerField(op, row, 'outbound_uncertain_count'),
    outboundManualReviewCount: integerField(op, row, 'outbound_manual_review_count'),
    outboundOldestAgeMs: nullableIntegerField(op, row, 'outbound_oldest_age_ms'),
    workers: arrayField(op, row, 'workers').map((item) => parseWorkerHeartbeat(op, item)),
  };
}

export function parsePrune(op: string, payload: unknown): TelegramPruneDeliveryResult {
  const row = record(op, payload);
  if (!booleanField(op, row, 'ok')) {
    return malformedTelegramRpcResponse(op);
  }
  return {
    ok: true,
    purgedPayloads: integerField(op, row, 'purged_payloads'),
    deletedIngressRows: integerField(op, row, 'deleted_ingress_rows'),
    deletedOutboundJobs: integerField(op, row, 'deleted_outbound_jobs'),
    deletedHeartbeats: integerField(op, row, 'deleted_heartbeats'),
  };
}

function parseWorkerHeartbeat(op: string, item: unknown): TelegramWorkerHeartbeatSnapshot {
  const row = record(op, item);
  const workerKind = stringField(op, row, 'worker_kind');
  if (!isWorkerKind(workerKind) || !isUuid(row.worker_id)) {
    return malformedTelegramRpcResponse(op);
  }
  return {
    workerKind,
    workerId: row.worker_id,
    startedAt: stringField(op, row, 'started_at'),
    heartbeatAt: stringField(op, row, 'heartbeat_at'),
    stoppingAt: nullableStringField(op, row, 'stopping_at'),
  };
}

function nullableIntegerField(
  op: string,
  row: Readonly<Record<string, unknown>>,
  key: string,
): number | null {
  const value = row[key];
  if (value === null || (typeof value === 'number' && Number.isSafeInteger(value))) {
    return value;
  }
  return malformedTelegramRpcResponse(op);
}
