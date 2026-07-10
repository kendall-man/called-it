import { describe, expect, it } from 'vitest';
import {
  TelegramOutboundCompletionWorker,
  type TelegramOutboundCompletionDb,
  type TelegramOutboundCompletionLease,
} from './outbound-completion-worker.js';

const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();

function createLease(
  overrides: Partial<TelegramOutboundCompletionLease> = {},
): TelegramOutboundCompletionLease {
  return {
    id: 'job-1',
    state: 'owned',
    chatId: -1001,
    domainKind: 'market_card',
    domainId: 'market-1',
    telegramMessageId: 42,
    leaseExpiresAt,
    ...overrides,
  };
}

function createDb(
  leases: readonly TelegramOutboundCompletionLease[],
  events: string[],
): TelegramOutboundCompletionDb {
  return {
    leaseOutboundCompletion: async () => leases,
    completeOutbound: async (jobId, workerId) => {
      events.push(`complete:${jobId}:${workerId}`);
      return { ok: true, state: 'complete', duplicate: false };
    },
  };
}

describe('TelegramOutboundCompletionWorker', () => {
  it('resumes an owned job after restart without a Telegram sender', async () => {
    const events: string[] = [];
    const worker = new TelegramOutboundCompletionWorker({
      db: createDb([createLease()], events),
      handlers: {
        market_card: async (job) => {
          events.push(`domain:${job.domainId}:${job.telegramMessageId}`);
        },
      },
      workerId: 'worker-1',
      batchSize: 10,
      leaseMs: 1_000,
      retryDelayMs: 0,
      wait: async () => undefined,
    });

    await expect(worker.runOnce(new AbortController().signal)).resolves.toBe(1);

    expect(events).toEqual(['domain:market-1:42', 'complete:job-1:worker-1']);
  });

  it('does not run domain completion when another worker holds the delivery lease', async () => {
    const events: string[] = [];
    const worker = new TelegramOutboundCompletionWorker({
      db: {
        ...createDb([], events),
        leaseOutboundCompletion: async () => [],
      },
      handlers: {
        market_card: async () => {
          events.push('domain');
        },
      },
      workerId: 'worker-1',
      batchSize: 10,
      leaseMs: 1_000,
    });

    await expect(worker.runOnce(new AbortController().signal)).resolves.toBe(0);
    expect(events).toEqual([]);
  });

  it('does not report a drain as successful after its abort deadline', async () => {
    const events: string[] = [];
    const started = deferred<void>();
    const released = deferred<void>();
    const worker = new TelegramOutboundCompletionWorker({
      db: createDb([createLease()], events),
      handlers: {
        market_card: async () => {
          started.resolve(undefined);
          await released.promise;
        },
      },
      workerId: 'worker-1',
      batchSize: 10,
      leaseMs: 1_000,
    });

    const active = worker.runOnce(new AbortController().signal);
    await started.promise;
    const controller = new AbortController();
    controller.abort();

    await expect(worker.drain(controller.signal)).resolves.toEqual({ kind: 'timeout', unfinished: 1 });
    released.resolve(undefined);
    await active;
  });

  it('does not retry domain completion beyond the delivery lease deadline', async () => {
    const events: string[] = [];
    let now = 0;
    let handlerCalls = 0;
    const lease = createLease({ leaseExpiresAt: new Date(10).toISOString() });
    const worker = new TelegramOutboundCompletionWorker({
      db: {
        ...createDb([lease], events),
        completeOutbound: async () => {
          events.push('complete');
          return { ok: false, code: 'lease_lost' };
        },
      },
      handlers: {
        market_card: async () => {
          handlerCalls += 1;
          events.push('domain');
        },
      },
      workerId: 'worker-1',
      batchSize: 10,
      leaseMs: 1_000,
      now: () => now,
      retryDelayMs: 20,
      wait: async (milliseconds) => {
        now += milliseconds;
      },
    });

    await expect(worker.runOnce(new AbortController().signal)).resolves.toBe(1);

    expect(handlerCalls).toBe(1);
    expect(events).toEqual(['domain', 'complete']);
  });
});

function deferred<T>() {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return {
    promise,
    resolve(value: T): void {
      resolve?.(value);
    },
  };
}
