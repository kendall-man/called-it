import { describe, expect, it } from 'vitest';
import { DbError, type PgResult } from './errors.js';
import { telegramDbFromClient, type TelegramDb } from './telegram-db.js';

const UPDATE_ID = '00000000-0000-4000-8000-000000000001';
const LEASED_UPDATE_ID = '00000000-0000-4000-8000-000000000002';
const WORKER_ID = '00000000-0000-4000-8000-000000000010';
const JOB_ID = '00000000-0000-4000-8000-000000000011';
const OUTBOUND_WORKER_ID = '00000000-0000-4000-8000-000000000012';
const HEARTBEAT_WORKER_ID = '00000000-0000-4000-8000-000000000013';
const RECONCILER_ID = '00000000-0000-4000-8000-000000000014';
const FINGERPRINT = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi1234567';
const OBSERVED_AT = '2026-07-11T00:00:00.000Z';
const LEASE_EXPIRES_AT = '2026-07-11T00:00:10.000Z';
const UPDATE_PAYLOAD = { update_id: 41, message: { message_id: 7, chat: { id: -1001 } } };

const persistInput = {
  sourceKey: 'msg:-1001:7',
  sourceFingerprint: FINGERPRINT,
  telegramUpdateId: 41,
  updateType: 'message',
  payload: UPDATE_PAYLOAD,
  routingDecision: 'pending_engine',
} satisfies Parameters<TelegramDb['persistUpdate']>[0];

const planInput = {
  logicalKey: 'logical:1',
  chatId: -1001,
  domainKind: 'market_card',
  domainId: 'market:1',
} satisfies Parameters<TelegramDb['planOutbound']>[0];

const retryInput = {
  updateRowId: UPDATE_ID,
  workerId: WORKER_ID,
  errorCode: 'telegram_retry',
  retryAt: OBSERVED_AT,
  maxAttempts: 4,
} satisfies Parameters<TelegramDb['retryUpdate']>[0];

type RpcHandler = (args: Record<string, unknown>) => PgResult<unknown>;
type ErrorShape = 'typed' | 'throws';

interface RpcCase {
  readonly fn: string;
  readonly args: Record<string, unknown>;
  readonly invoke: (db: TelegramDb) => Promise<unknown>;
  readonly successPayload: unknown;
  readonly expectedResult: unknown;
  readonly errorShape: ErrorShape;
}

class FakeTelegramRpcClient {
  readonly calls: Array<{ readonly fn: string; readonly args: Record<string, unknown> }> = [];
  private readonly handlers = new Map<string, RpcHandler>();

  onRpc(fn: string, handler: RpcHandler): void {
    this.handlers.set(fn, handler);
  }

  rpc(fn: string, args: Record<string, unknown>): Promise<PgResult<unknown>> {
    this.calls.push({ fn, args });
    const handler = this.handlers.get(fn);
    if (!handler) {
      return Promise.resolve({ data: null, error: { message: `missing fake handler for ${fn}` } });
    }
    return Promise.resolve(handler(args));
  }
}

const RPC_CASES: readonly RpcCase[] = [
  {
    fn: 'telegram_persist_update',
    args: {
      p_source_key: persistInput.sourceKey,
      p_source_fingerprint: persistInput.sourceFingerprint,
      p_telegram_update_id: persistInput.telegramUpdateId,
      p_update_type: persistInput.updateType,
      p_payload: persistInput.payload,
      p_routing_decision: persistInput.routingDecision,
    },
    invoke: (db) => db.persistUpdate(persistInput),
    successPayload: {
      ok: true,
      id: UPDATE_ID,
      routing_decision: 'pending_engine',
      state: 'pending_engine',
      duplicate: false,
    },
    expectedResult: {
      ok: true,
      id: UPDATE_ID,
      routingDecision: 'pending_engine',
      state: 'pending_engine',
      duplicate: false,
    },
    errorShape: 'typed',
  },
  {
    fn: 'telegram_lease_updates',
    args: { p_worker_id: WORKER_ID, p_limit: 5, p_lease_ms: 10_000 },
    invoke: (db) => db.leaseUpdates(WORKER_ID, 5, 10_000),
    successPayload: {
      ok: true,
      items: [{
        id: LEASED_UPDATE_ID,
        telegram_update_id: 41,
        update_type: 'message',
        routing_decision: 'pending_engine',
        state: 'leased',
        attempts: 1,
        source_fingerprint: FINGERPRINT,
        payload: UPDATE_PAYLOAD,
        lease_expires_at: LEASE_EXPIRES_AT,
      }],
    },
    expectedResult: [{
      id: LEASED_UPDATE_ID,
      telegramUpdateId: 41,
      updateType: 'message',
      routingDecision: 'pending_engine',
      state: 'leased',
      attempts: 1,
      sourceFingerprint: FINGERPRINT,
      payload: UPDATE_PAYLOAD,
      leaseExpiresAt: LEASE_EXPIRES_AT,
    }],
    errorShape: 'throws',
  },
  {
    fn: 'telegram_complete_update',
    args: { p_update_row_id: UPDATE_ID, p_worker_id: WORKER_ID },
    invoke: (db) => db.completeUpdate(UPDATE_ID, WORKER_ID),
    successPayload: { ok: true, id: UPDATE_ID, state: 'completed', duplicate: false },
    expectedResult: { ok: true, id: UPDATE_ID, state: 'completed', duplicate: false },
    errorShape: 'typed',
  },
  {
    fn: 'telegram_retry_update',
    args: {
      p_update_row_id: retryInput.updateRowId,
      p_worker_id: retryInput.workerId,
      p_error_code: retryInput.errorCode,
      p_retry_at: retryInput.retryAt,
      p_max_attempts: retryInput.maxAttempts,
    },
    invoke: (db) => db.retryUpdate(retryInput),
    successPayload: { ok: true, id: UPDATE_ID, state: 'retry_wait', duplicate: false },
    expectedResult: { ok: true, id: UPDATE_ID, state: 'retry_wait', duplicate: false },
    errorShape: 'typed',
  },
  {
    fn: 'telegram_dead_letter_update',
    args: { p_update_row_id: UPDATE_ID, p_worker_id: WORKER_ID, p_error_code: 'telegram_dead' },
    invoke: (db) => db.deadLetterUpdate(UPDATE_ID, WORKER_ID, 'telegram_dead'),
    successPayload: { ok: true, id: UPDATE_ID, state: 'dead', duplicate: false },
    expectedResult: { ok: true, id: UPDATE_ID, state: 'dead', duplicate: false },
    errorShape: 'typed',
  },
  {
    fn: 'telegram_plan_outbound',
    args: {
      p_logical_key: planInput.logicalKey,
      p_chat_id: planInput.chatId,
      p_domain_kind: planInput.domainKind,
      p_domain_id: planInput.domainId,
    },
    invoke: (db) => db.planOutbound(planInput),
    successPayload: {
      ok: true,
      id: JOB_ID,
      state: 'planned',
      chat_id: -1001,
      domain_kind: 'market_card',
      domain_id: 'market:1',
      duplicate: false,
    },
    expectedResult: {
      ok: true,
      id: JOB_ID,
      state: 'planned',
      chatId: -1001,
      domainKind: 'market_card',
      domainId: 'market:1',
      duplicate: false,
    },
    errorShape: 'typed',
  },
  {
    fn: 'telegram_start_outbound',
    args: { p_job_id: JOB_ID, p_worker_id: OUTBOUND_WORKER_ID, p_lease_ms: 10_000 },
    invoke: (db) => db.startOutbound(JOB_ID, OUTBOUND_WORKER_ID, 10_000),
    successPayload: {
      ok: true,
      id: JOB_ID,
      state: 'sending',
      chat_id: -1001,
      domain_kind: 'market_card',
      domain_id: 'market:1',
      lease_expires_at: LEASE_EXPIRES_AT,
    },
    expectedResult: {
      ok: true,
      id: JOB_ID,
      state: 'sending',
      chatId: -1001,
      domainKind: 'market_card',
      domainId: 'market:1',
      leaseExpiresAt: LEASE_EXPIRES_AT,
    },
    errorShape: 'typed',
  },
  {
    fn: 'telegram_mark_outbound_owned',
    args: { p_job_id: JOB_ID, p_worker_id: OUTBOUND_WORKER_ID, p_message_id: 77 },
    invoke: (db) => db.markOutboundOwned(JOB_ID, OUTBOUND_WORKER_ID, 77),
    successPayload: { ok: true, id: JOB_ID, state: 'owned', duplicate: false },
    expectedResult: { ok: true, id: JOB_ID, state: 'owned', duplicate: false },
    errorShape: 'typed',
  },
  {
    fn: 'telegram_complete_outbound',
    args: { p_job_id: JOB_ID, p_worker_id: OUTBOUND_WORKER_ID },
    invoke: (db) => db.completeOutbound(JOB_ID, OUTBOUND_WORKER_ID),
    successPayload: { ok: true, id: JOB_ID, state: 'complete', duplicate: false },
    expectedResult: { ok: true, id: JOB_ID, state: 'complete', duplicate: false },
    errorShape: 'typed',
  },
  {
    fn: 'telegram_mark_outbound_uncertain',
    args: { p_job_id: JOB_ID, p_worker_id: OUTBOUND_WORKER_ID, p_error_code: 'telegram_timeout' },
    invoke: (db) => db.markOutboundUncertain(JOB_ID, OUTBOUND_WORKER_ID, 'telegram_timeout'),
    successPayload: { ok: true, id: JOB_ID, state: 'ownership_uncertain', duplicate: false },
    expectedResult: { ok: true, id: JOB_ID, state: 'ownership_uncertain', duplicate: false },
    errorShape: 'typed',
  },
  {
    fn: 'telegram_sweep_expired_outbound',
    args: { p_limit: 7 },
    invoke: (db) => db.sweepExpiredOutbound(7),
    successPayload: { ok: true, count: 2 },
    expectedResult: 2,
    errorShape: 'throws',
  },
  {
    fn: 'telegram_lease_uncertain_ownership',
    args: { p_worker_id: RECONCILER_ID, p_limit: 3, p_lease_ms: 10_000 },
    invoke: (db) => db.leaseUncertainOwnership(RECONCILER_ID, 3, 10_000),
    successPayload: {
      ok: true,
      items: [{
        id: JOB_ID,
        chat_id: -1001,
        domain_kind: 'market_card',
        domain_id: 'market:1',
        state: 'ownership_uncertain',
        reconcile_attempts: 2,
        lease_expires_at: LEASE_EXPIRES_AT,
      }],
    },
    expectedResult: [{
      id: JOB_ID,
      chatId: -1001,
      domainKind: 'market_card',
      domainId: 'market:1',
      state: 'ownership_uncertain',
      reconcileAttempts: 2,
      leaseExpiresAt: LEASE_EXPIRES_AT,
    }],
    errorShape: 'throws',
  },
  {
    fn: 'telegram_lease_outbound_completion',
    args: { p_worker_id: RECONCILER_ID, p_limit: 3, p_lease_ms: 10_000 },
    invoke: (db) => db.leaseOutboundCompletion(RECONCILER_ID, 3, 10_000),
    successPayload: {
      ok: true,
      items: [{
        id: JOB_ID,
        chat_id: -1001,
        domain_kind: 'market_card',
        domain_id: 'market:1',
        state: 'reconciled',
        telegram_message_id: 78,
        lease_expires_at: LEASE_EXPIRES_AT,
      }],
    },
    expectedResult: [{
      id: JOB_ID,
      chatId: -1001,
      domainKind: 'market_card',
      domainId: 'market:1',
      state: 'reconciled',
      telegramMessageId: 78,
      leaseExpiresAt: LEASE_EXPIRES_AT,
    }],
    errorShape: 'throws',
  },
  {
    fn: 'telegram_reconcile_outbound',
    args: { p_job_id: JOB_ID, p_worker_id: RECONCILER_ID, p_message_id: 78 },
    invoke: (db) => db.reconcileOutbound(JOB_ID, RECONCILER_ID, 78),
    successPayload: { ok: true, id: JOB_ID, state: 'reconciled', duplicate: false },
    expectedResult: { ok: true, id: JOB_ID, state: 'reconciled', duplicate: false },
    errorShape: 'typed',
  },
  {
    fn: 'telegram_manual_review_outbound',
    args: {
      p_job_id: JOB_ID,
      p_worker_id: RECONCILER_ID,
      p_error_code: 'telegram_manual_review',
    },
    invoke: (db) => db.manualReviewOutbound(JOB_ID, RECONCILER_ID, 'telegram_manual_review'),
    successPayload: { ok: true, id: JOB_ID, state: 'manual_review', duplicate: false },
    expectedResult: { ok: true, id: JOB_ID, state: 'manual_review', duplicate: false },
    errorShape: 'typed',
  },
  {
    fn: 'telegram_resolve_owned_message',
    args: { p_chat_id: -1001, p_message_id: 77 },
    invoke: (db) => db.resolveOwnedMessage(-1001, 77),
    successPayload: {
      ok: true,
      owner: 'engine',
      job_id: JOB_ID,
      domain_kind: 'market_card',
      domain_id: 'market:1',
    },
    expectedResult: {
      ok: true,
      owner: 'engine',
      jobId: JOB_ID,
      domainKind: 'market_card',
      domainId: 'market:1',
    },
    errorShape: 'typed',
  },
  {
    fn: 'engine_heartbeat_worker',
    args: { p_worker_kind: 'telegram_ingress', p_worker_id: HEARTBEAT_WORKER_ID, p_stopping: false },
    invoke: (db) => db.heartbeatWorker('telegram_ingress', HEARTBEAT_WORKER_ID, false),
    successPayload: { ok: true },
    expectedResult: undefined,
    errorShape: 'throws',
  },
  {
    fn: 'telegram_delivery_snapshot',
    args: { p_observed_at: OBSERVED_AT },
    invoke: (db) => db.deliverySnapshot(OBSERVED_AT),
    successPayload: {
      ok: true,
      observed_at: OBSERVED_AT,
      ingress_active_count: 1,
      ingress_dead_count: 0,
      ingress_oldest_age_ms: 500,
      outbound_uncertain_count: 2,
      outbound_manual_review_count: 1,
      outbound_oldest_age_ms: 1_000,
      workers: [{
        worker_kind: 'telegram_ingress',
        worker_id: HEARTBEAT_WORKER_ID,
        started_at: OBSERVED_AT,
        heartbeat_at: '2026-07-11T00:00:01.000Z',
        stopping_at: null,
      }],
    },
    expectedResult: {
      ok: true,
      observedAt: OBSERVED_AT,
      ingressActiveCount: 1,
      ingressDeadCount: 0,
      ingressOldestAgeMs: 500,
      outboundUncertainCount: 2,
      outboundManualReviewCount: 1,
      outboundOldestAgeMs: 1_000,
      workers: [{
        workerKind: 'telegram_ingress',
        workerId: HEARTBEAT_WORKER_ID,
        startedAt: OBSERVED_AT,
        heartbeatAt: '2026-07-11T00:00:01.000Z',
        stoppingAt: null,
      }],
    },
    errorShape: 'throws',
  },
  {
    fn: 'telegram_prune_delivery',
    args: { p_limit: 50 },
    invoke: (db) => db.pruneDelivery(50),
    successPayload: {
      ok: true,
      purged_payloads: 1,
      deleted_ingress_rows: 2,
      deleted_outbound_jobs: 3,
      deleted_heartbeats: 4,
    },
    expectedResult: {
      ok: true,
      purgedPayloads: 1,
      deletedIngressRows: 2,
      deletedOutboundJobs: 3,
      deletedHeartbeats: 4,
    },
    errorShape: 'throws',
  },
];

describe('telegramDbFromClient', () => {
  it('forwards exact p args and parses successful replies for all Telegram RPC wrappers', async () => {
    const fake = new FakeTelegramRpcClient();
    for (const rpcCase of RPC_CASES) {
      fake.onRpc(rpcCase.fn, () => ({ data: rpcCase.successPayload, error: null }));
    }
    const db = telegramDbFromClient(fake);

    const results: unknown[] = [];
    for (const rpcCase of RPC_CASES) {
      results.push(await rpcCase.invoke(db));
    }

    expect(results).toEqual(RPC_CASES.map((rpcCase) => rpcCase.expectedResult));
    expect(fake.calls).toEqual(RPC_CASES.map((rpcCase) => ({ fn: rpcCase.fn, args: rpcCase.args })));
  });

  it('returns typed failures or DbError for ok false replies from all Telegram RPC wrappers', async () => {
    for (const rpcCase of RPC_CASES) {
      const fake = new FakeTelegramRpcClient();
      fake.onRpc(rpcCase.fn, () => ({ data: { ok: false, code: 'not_found' }, error: null }));
      const db = telegramDbFromClient(fake);

      if (rpcCase.errorShape === 'typed') {
        await expect(rpcCase.invoke(db)).resolves.toEqual({ ok: false, code: 'not_found' });
      } else {
        await expect(rpcCase.invoke(db)).rejects.toThrow(DbError);
      }
      expect(fake.calls).toEqual([{ fn: rpcCase.fn, args: rpcCase.args }]);
    }
  });

  it('preserves a duplicate persisted update at its current state', async () => {
    const fake = new FakeTelegramRpcClient();
    fake.onRpc('telegram_persist_update', () => ({
      data: {
        ok: true,
        id: UPDATE_ID,
        routing_decision: 'pending_engine',
        state: 'leased',
        duplicate: true,
      },
      error: null,
    }));
    const db = telegramDbFromClient(fake);

    await expect(db.persistUpdate(persistInput)).resolves.toEqual({
      ok: true,
      id: UPDATE_ID,
      routingDecision: 'pending_engine',
      state: 'leased',
      duplicate: true,
    });
  });

  it('fails closed on malformed UUID, state, count, payload, and code replies', async () => {
    const rawSentinel = 'RAW_RPC_PAYLOAD_SENTINEL';
    const malformedPayloadCase: RpcCase = {
      fn: 'telegram_lease_updates',
      args: { p_worker_id: WORKER_ID, p_limit: 5, p_lease_ms: 10_000 },
      invoke: (db) => db.leaseUpdates(WORKER_ID, 5, 10_000),
      successPayload: {
        ok: true,
        items: [{
          id: LEASED_UPDATE_ID,
          telegram_update_id: 41,
          update_type: 'message',
          routing_decision: 'pending_engine',
          state: 'leased',
          attempts: 1,
          source_fingerprint: FINGERPRINT,
          payload: rawSentinel,
          lease_expires_at: LEASE_EXPIRES_AT,
        }],
      },
      expectedResult: undefined,
      errorShape: 'throws',
    };
    const malformedCases: readonly RpcCase[] = [
      {
        fn: 'telegram_persist_update',
        args: {
          p_source_key: persistInput.sourceKey,
          p_source_fingerprint: persistInput.sourceFingerprint,
          p_telegram_update_id: persistInput.telegramUpdateId,
          p_update_type: persistInput.updateType,
          p_payload: persistInput.payload,
          p_routing_decision: persistInput.routingDecision,
        },
        invoke: (db) => db.persistUpdate(persistInput),
        successPayload: {
          ok: true,
          id: 'not-a-uuid',
          routing_decision: 'pending_engine',
          state: 'pending_engine',
          duplicate: false,
        },
        expectedResult: undefined,
        errorShape: 'throws',
      },
      {
        fn: 'telegram_complete_update',
        args: { p_update_row_id: UPDATE_ID, p_worker_id: WORKER_ID },
        invoke: (db) => db.completeUpdate(UPDATE_ID, WORKER_ID),
        successPayload: { ok: false, code: 'terminal_state', state: 'not-a-state' },
        expectedResult: undefined,
        errorShape: 'throws',
      },
      {
        fn: 'telegram_lease_outbound_completion',
        args: { p_worker_id: RECONCILER_ID, p_limit: 3, p_lease_ms: 10_000 },
        invoke: (db) => db.leaseOutboundCompletion(RECONCILER_ID, 3, 10_000),
        successPayload: {
          ok: true,
          items: [{
            id: JOB_ID,
            chat_id: -1001,
            domain_kind: 'market_card',
            domain_id: 'market:1',
            state: 'owned',
            telegram_message_id: 'not-an-integer',
            lease_expires_at: LEASE_EXPIRES_AT,
          }],
        },
        expectedResult: undefined,
        errorShape: 'throws',
      },
      {
        fn: 'telegram_lease_outbound_completion',
        args: { p_worker_id: RECONCILER_ID, p_limit: 3, p_lease_ms: 10_000 },
        invoke: (db) => db.leaseOutboundCompletion(RECONCILER_ID, 3, 10_000),
        successPayload: {
          ok: true,
          items: [{
            id: JOB_ID,
            chat_id: -1001,
            domain_kind: 'market_card',
            domain_id: 'market:1',
            state: 'owned',
            telegram_message_id: 77,
            lease_expires_at: LEASE_EXPIRES_AT,
            unexpected: 'not part of the RPC contract',
          }],
        },
        expectedResult: undefined,
        errorShape: 'throws',
      },
      {
        fn: 'telegram_sweep_expired_outbound',
        args: { p_limit: 7 },
        invoke: (db) => db.sweepExpiredOutbound(7),
        successPayload: { ok: true, count: 1.5 },
        expectedResult: undefined,
        errorShape: 'throws',
      },
      malformedPayloadCase,
      {
        fn: 'telegram_persist_update',
        args: {
          p_source_key: persistInput.sourceKey,
          p_source_fingerprint: persistInput.sourceFingerprint,
          p_telegram_update_id: persistInput.telegramUpdateId,
          p_update_type: persistInput.updateType,
          p_payload: persistInput.payload,
          p_routing_decision: persistInput.routingDecision,
        },
        invoke: (db) => db.persistUpdate(persistInput),
        successPayload: { ok: false, code: 'not_a_telegram_code' },
        expectedResult: undefined,
        errorShape: 'throws',
      },
    ];

    for (const rpcCase of malformedCases) {
      const fake = new FakeTelegramRpcClient();
      fake.onRpc(rpcCase.fn, () => ({ data: rpcCase.successPayload, error: null }));
      const call = rpcCase.invoke(telegramDbFromClient(fake));

      await expect(call).rejects.toThrow(DbError);
      await expect(call).rejects.toThrow('malformed RPC response');
    }

    const fake = new FakeTelegramRpcClient();
    fake.onRpc(malformedPayloadCase.fn, () => ({ data: malformedPayloadCase.successPayload, error: null }));
    await expect(malformedPayloadCase.invoke(telegramDbFromClient(fake))).rejects.not.toThrow(rawSentinel);
  });

  it('does not expose raw RPC response text when the RPC client reports an error', async () => {
    const fake = new FakeTelegramRpcClient();
    const rawSentinel = 'RAW_RPC_RESPONSE_SENTINEL';
    fake.onRpc('telegram_delivery_snapshot', () => ({
      data: null,
      error: { message: rawSentinel },
    }));
    const call = telegramDbFromClient(fake).deliverySnapshot(OBSERVED_AT);

    await expect(call).rejects.toThrow(DbError);
    await expect(call).rejects.toThrow('malformed RPC response');
    await expect(call).rejects.not.toThrow(rawSentinel);
  });
});
