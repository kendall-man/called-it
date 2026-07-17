import type { ProofSubmissionOutboxDb } from '@calledit/db';
import type { Logger } from './log.js';
import type { EngineRuntimeTelegramDb } from './runtime.js';

export const RUNTIME_TEST_NOW = 1_000;
export const RUNTIME_TEST_WORKER_ID = '22222222-2222-4222-8222-222222222222';

export function silentLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => silentLogger(),
  };
}

export function unusedOutbox(): ProofSubmissionOutboxDb {
  return {
    get: async () => ({ ok: true, outbox: null }),
    prepare: async () => {
      throw new Error('void proof never prepares an outbox submission');
    },
    markBroadcast: async () => {
      throw new Error('void proof never broadcasts an outbox submission');
    },
    markLanded: async () => {
      throw new Error('void proof never lands an outbox submission');
    },
    markExpired: async () => {
      throw new Error('void proof never expires an outbox submission');
    },
  };
}

export function createRuntimeTelegramFacade(trace: string[]): EngineRuntimeTelegramDb {
  let ingressLeased = false;
  return {
    persistUpdate: async () => ({
      ok: true,
      id: 'update-7',
      routingDecision: 'pending_engine',
      state: 'pending_engine',
      duplicate: false,
    }),
    leaseUpdates: async () => {
      if (ingressLeased) return [];
      ingressLeased = true;
      return [{
        id: 'update-7',
        telegramUpdateId: 7,
        updateType: 'message',
        routingDecision: 'pending_engine',
        state: 'leased',
        attempts: 1,
        sourceFingerprint: 'source-7',
        payload: { update_id: 7 },
        leaseExpiresAt: new Date(RUNTIME_TEST_NOW + 10_000).toISOString(),
      }];
    },
    completeUpdate: async (updateRowId) => {
      trace.push(`complete_update:${updateRowId}`);
      return { ok: true, id: updateRowId, state: 'completed', duplicate: false };
    },
    retryUpdate: async ({ updateRowId }) => ({
      ok: true,
      id: updateRowId,
      state: 'retry_wait',
      duplicate: false,
    }),
    deadLetterUpdate: async (updateRowId) => ({
      ok: true,
      id: updateRowId,
      state: 'dead',
      duplicate: false,
    }),
    planOutbound: async (input) => ({
      ok: true,
      id: 'outbound-1',
      state: 'planned',
      chatId: input.chatId,
      domainKind: input.domainKind,
      domainId: input.domainId,
      duplicate: false,
    }),
    startOutbound: async () => ({
      ok: true,
      id: 'outbound-1',
      state: 'sending',
      chatId: 1,
      domainKind: 'group_ready',
      domainId: 'group-1',
      leaseExpiresAt: new Date(RUNTIME_TEST_NOW + 10_000).toISOString(),
    }),
    markOutboundOwned: async (jobId) => ({ ok: true, id: jobId, state: 'owned', duplicate: false }),
    markOutboundUncertain: async (jobId) => ({
      ok: true,
      id: jobId,
      state: 'ownership_uncertain',
      duplicate: false,
    }),
    completeOutbound: async (jobId) => ({ ok: true, id: jobId, state: 'complete', duplicate: false }),
    sweepExpiredOutbound: async () => {
      trace.push('sweep_outbound');
      return 0;
    },
    leaseUncertainOwnership: async () => [],
    leaseOutboundCompletion: async () => [],
    reconcileOutbound: async (jobId) => ({
      ok: true,
      id: jobId,
      state: 'reconciled',
      duplicate: false,
    }),
    manualReviewOutbound: async (jobId) => ({
      ok: true,
      id: jobId,
      state: 'manual_review',
      duplicate: false,
    }),
    heartbeatWorker: async (workerKind, workerId, stopping) => {
      trace.push(`${workerKind}:${workerId}:${String(stopping)}`);
    },
    deliverySnapshot: async () => ({
      ok: true,
      observedAt: new Date(RUNTIME_TEST_NOW).toISOString(),
      ingressActiveCount: 0,
      ingressDeadCount: 0,
      ingressOldestAgeMs: null,
      outboundUncertainCount: 0,
      outboundManualReviewCount: 0,
      outboundOldestAgeMs: null,
      workers: [{
        workerKind: 'telegram_ingress',
        workerId: RUNTIME_TEST_WORKER_ID,
        startedAt: new Date(RUNTIME_TEST_NOW).toISOString(),
        heartbeatAt: new Date(RUNTIME_TEST_NOW).toISOString(),
        stoppingAt: null,
      }],
    }),
  };
}
