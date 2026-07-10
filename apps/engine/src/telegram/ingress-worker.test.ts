import { describe, expect, it } from 'vitest';
import {
  TelegramIngressPermanentError,
  TelegramIngressWorker,
  type TelegramIngressHandler,
  type TelegramIngressLeasedUpdate,
  type TelegramIngressQueuePolicy,
  type TelegramIngressWorkerDb,
} from './ingress-worker.js';

const WORKER_ID = '00000000-0000-4000-8000-000000000001';
const POLICY = {
  batchSize: 2,
  leaseMs: 5_000,
  maxAttempts: 3,
  retryBaseMs: 100,
  retryMaxMs: 1_000,
} satisfies TelegramIngressQueuePolicy;

interface RetryCall {
  readonly updateRowId: string;
  readonly workerId: string;
  readonly errorCode: string;
  readonly retryAt: string;
  readonly maxAttempts: number;
}

interface WorkerHarness {
  readonly db: TelegramIngressWorkerDb;
  readonly completed: string[];
  readonly dead: Array<readonly [string, string, string]>;
  readonly heartbeats: boolean[];
  readonly leaseCalls: Array<readonly [string, number, number]>;
  readonly retries: RetryCall[];
}

function lease(id: string, attempts: number): TelegramIngressLeasedUpdate {
  return {
    id,
    attempts,
    sourceFingerprint: `fingerprint-${id}`,
    payload: { update_id: attempts },
  };
}

function createHarness(leases: readonly TelegramIngressLeasedUpdate[]): WorkerHarness {
  const completed: string[] = [];
  const dead: Array<readonly [string, string, string]> = [];
  const heartbeats: boolean[] = [];
  const leaseCalls: Array<readonly [string, number, number]> = [];
  const retries: RetryCall[] = [];
  return {
    completed,
    dead,
    heartbeats,
    leaseCalls,
    retries,
    db: {
      heartbeatWorker: async (_kind, _workerId, stopping) => {
        heartbeats.push(stopping);
      },
      leaseUpdates: async (workerId, limit, leaseMs) => {
        leaseCalls.push([workerId, limit, leaseMs]);
        return leases;
      },
      completeUpdate: async (updateRowId) => {
        completed.push(updateRowId);
        return { ok: true };
      },
      retryUpdate: async (input) => {
        retries.push(input);
        return { ok: true };
      },
      deadLetterUpdate: async (updateRowId, workerId, errorCode) => {
        dead.push([updateRowId, workerId, errorCode]);
        return { ok: true };
      },
    },
  };
}

function createWorker(input: {
  readonly db: TelegramIngressWorkerDb;
  readonly handler: TelegramIngressHandler;
  readonly logs?: unknown[];
  readonly nowMs?: number;
  readonly randomValue?: number;
}): TelegramIngressWorker {
  const logs = input.logs ?? [];
  return new TelegramIngressWorker({
    db: input.db,
    handler: input.handler,
    logger: { warn: (event, fields) => logs.push({ event, fields }) },
    clock: { now: () => input.nowMs ?? 10_000 },
    random: { next: () => input.randomValue ?? 0 },
    queuePolicy: POLICY,
    workerId: WORKER_ID,
  });
}

describe('TelegramIngressWorker', () => {
  it('leases a bounded batch and completes the handled update', async () => {
    const item = lease('00000000-0000-4000-8000-000000000011', 1);
    const harness = createHarness([item]);
    const handled: Readonly<Record<string, unknown>>[] = [];
    const worker = createWorker({
      db: harness.db,
      handler: async (payload) => {
        handled.push(payload);
      },
    });

    await expect(worker.runOnce(new AbortController().signal)).resolves.toBe(1);

    expect(harness.leaseCalls).toEqual([[WORKER_ID, POLICY.batchSize, POLICY.leaseMs]]);
    expect(handled).toEqual([item.payload]);
    expect(harness.completed).toEqual([item.id]);
    expect(harness.heartbeats).toEqual([false, false]);
  });

  it('isolates a permanent poison update while completing another leased update', async () => {
    const poison = lease('00000000-0000-4000-8000-000000000021', 1);
    const healthy = lease('00000000-0000-4000-8000-000000000022', 1);
    const harness = createHarness([poison, healthy]);
    const worker = createWorker({
      db: harness.db,
      handler: async (payload) => {
        if (payload === poison.payload) {
          throw new TelegramIngressPermanentError('invalid_update');
        }
      },
    });

    await expect(worker.runOnce(new AbortController().signal)).resolves.toBe(2);

    expect(harness.dead).toEqual([[poison.id, WORKER_ID, 'invalid_update']]);
    expect(harness.completed).toEqual([healthy.id]);
  });

  it('uses equal-jitter retry timing inputs without recording the error text', async () => {
    const item = lease('00000000-0000-4000-8000-000000000031', 2);
    const harness = createHarness([item]);
    const logs: unknown[] = [];
    const worker = createWorker({
      db: harness.db,
      handler: async () => {
        throw new Error('private transient failure');
      },
      logs,
    });

    await expect(worker.runOnce(new AbortController().signal)).resolves.toBe(1);

    expect(harness.retries).toEqual([
      {
        updateRowId: item.id,
        workerId: WORKER_ID,
        errorCode: 'handler_error',
        retryAt: '1970-01-01T00:00:10.100Z',
        maxAttempts: POLICY.maxAttempts,
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain('private transient failure');
  });

  it('delegates max-attempt dead-lettering to the atomic retry transition', async () => {
    const item = lease('00000000-0000-4000-8000-000000000041', POLICY.maxAttempts);
    const harness = createHarness([item]);
    const worker = createWorker({
      db: harness.db,
      handler: async () => {
        throw new Error('retry ceiling');
      },
    });

    await expect(worker.runOnce(new AbortController().signal)).resolves.toBe(1);

    expect(harness.retries).toHaveLength(1);
    expect(harness.retries[0]?.maxAttempts).toBe(POLICY.maxAttempts);
    expect(harness.dead).toEqual([]);
  });

  it('rethrows a non-Error after recording a stable retry transition', async () => {
    const item = lease('00000000-0000-4000-8000-000000000051', 1);
    const thrown = { kind: 'unexpected' };
    const harness = createHarness([item]);
    const worker = createWorker({
      db: harness.db,
      handler: async () => {
        throw thrown;
      },
    });

    await expect(worker.runOnce(new AbortController().signal)).rejects.toBe(thrown);

    expect(harness.retries[0]?.errorCode).toBe('unknown_exception');
    expect(harness.heartbeats).toEqual([false, false]);
  });

  it('stops acquiring leases and drains only the in-flight handler', async () => {
    const item = lease('00000000-0000-4000-8000-000000000061', 1);
    const harness = createHarness([item]);
    let release: () => void = () => undefined;
    let signalStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const worker = createWorker({
      db: harness.db,
      handler: async () =>
        new Promise<void>((resolve) => {
          release = resolve;
          signalStarted();
        }),
    });

    const running = worker.runOnce(new AbortController().signal);
    await started;
    expect(worker.unfinished()).toBe(1);

    worker.stopLeasing();
    await expect(worker.runOnce(new AbortController().signal)).resolves.toBe(0);
    const draining = worker.drain(new AbortController().signal);
    expect(worker.unfinished()).toBe(1);

    release();
    await draining;
    await running;

    expect(worker.unfinished()).toBe(0);
    expect(harness.leaseCalls).toHaveLength(1);
  });
});
