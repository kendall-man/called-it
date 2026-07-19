import { afterEach, describe, expect, it, vi } from 'vitest';
import { EscrowReconciliationError } from './reconciler.js';
import {
  createEscrowPeriodicReconciliationRunner,
  type EscrowPeriodicReconciliationLink,
  type EscrowPeriodicReconciliationLog,
} from './periodic-reconciliation-runner.js';

const links: readonly EscrowPeriodicReconciliationLink[] = [
  {
    marketId: 'market-a',
    custodyMode: 'escrow',
    marketPda: 'market-pda-a',
    vaultPda: 'vault-pda-a',
    asset: 'sol',
  },
  {
    marketId: 'market-b',
    custodyMode: 'escrow',
    marketPda: 'market-pda-b',
    vaultPda: 'vault-pda-b',
    asset: 'usdc',
  },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function logger() {
  const events: Array<{
    level: 'info' | 'warn';
    event: string;
    fields: Readonly<Record<string, unknown>> | undefined;
  }> = [];
  const log: EscrowPeriodicReconciliationLog = {
    info(event, fields) {
      events.push({ level: 'info', event, fields });
    },
    warn(event, fields) {
      events.push({ level: 'warn', event, fields });
    },
  };
  return { log, events };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('periodic escrow reconciliation runner', () => {
  it('fails closed before reconciliation when a replay link is outside the active run', async () => {
    const reconciled: string[] = [];
    const { log } = logger();
    const runner = createEscrowPeriodicReconciliationRunner({
      links: {
        async listReconciliationLinks() {
          return { links, nextCursor: null };
        },
      },
      admitLink: async (link) => link.marketId === 'market-b',
      reconciler: {
        async reconcile(link) {
          reconciled.push(link.marketId);
          return { status: 'in_sync' };
        },
      },
      batchSize: 2,
      intervalMs: 1_000,
      log,
    });

    await expect(runner.runOnce()).resolves.toEqual({
      attempted: 1,
      succeeded: 1,
      failed: 0,
      sweepComplete: true,
    });
    expect(reconciled).toEqual(['market-b']);
  });

  it('runs a bounded startup batch and advances deterministic pages on each cadence', async () => {
    vi.useFakeTimers();
    const listInputs: Array<{ cursor: string | null; limit: number }> = [];
    const reconciled: string[] = [];
    const pages = [
      { links, nextCursor: 'market-b' },
      { links: [{ ...links[0]!, marketId: 'market-c' }], nextCursor: null },
      { links: links.slice(0, 1), nextCursor: null },
    ];
    const { log } = logger();
    const runner = createEscrowPeriodicReconciliationRunner({
      links: {
        async listReconciliationLinks(input) {
          listInputs.push(input);
          return pages.shift() ?? { links: [], nextCursor: null };
        },
      },
      reconciler: {
        async reconcile(link) {
          reconciled.push(link.marketId);
          return { status: 'in_sync' };
        },
      },
      batchSize: 2,
      intervalMs: 1_000,
      log,
    });

    runner.start();
    await runner.runOnce();

    expect(listInputs).toEqual([{ cursor: null, limit: 2 }]);
    expect(reconciled).toEqual(['market-a', 'market-b']);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(listInputs[1]).toEqual({ cursor: 'market-b', limit: 2 });
    expect(reconciled).toEqual(['market-a', 'market-b', 'market-c']);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(listInputs[2]).toEqual({ cursor: null, limit: 2 });
    expect(reconciled).toEqual(['market-a', 'market-b', 'market-c', 'market-a']);
  });

  it('isolates market failures, reports only stable codes and IDs, and completes the batch', async () => {
    const { log, events } = logger();
    const visited: string[] = [];
    const runner = createEscrowPeriodicReconciliationRunner({
      links: {
        async listReconciliationLinks() {
          return {
            links: [...links, { ...links[0]!, marketId: 'market-c' }],
            nextCursor: null,
          };
        },
      },
      reconciler: {
        async reconcile(link) {
          visited.push(link.marketId);
          if (link.marketId === 'market-a') {
            throw new EscrowReconciliationError('chain_identity_mismatch');
          }
          if (link.marketId === 'market-b') {
            throw new Error('provider leaked a sensitive dynamic message');
          }
          return { status: 'drift' };
        },
      },
      batchSize: 3,
      intervalMs: 1_000,
      log,
    });

    await expect(runner.runOnce()).resolves.toEqual({
      attempted: 3,
      succeeded: 1,
      failed: 2,
      sweepComplete: true,
    });

    expect(visited).toEqual(['market-a', 'market-b', 'market-c']);
    expect(events.filter(({ event }) => event === 'escrow_periodic_reconciliation_market_failed')).toEqual([
      {
        level: 'warn',
        event: 'escrow_periodic_reconciliation_market_failed',
        fields: { marketId: 'market-a', code: 'chain_identity_mismatch' },
      },
      {
        level: 'warn',
        event: 'escrow_periodic_reconciliation_market_failed',
        fields: { marketId: 'market-b', code: 'reconcile_failed' },
      },
    ]);
    expect(events).toContainEqual({
      level: 'warn',
      event: 'escrow_periodic_reconciliation_drift',
      fields: { marketId: 'market-c', code: 'vault_liability_drift' },
    });
    expect(JSON.stringify(events)).not.toContain('sensitive dynamic message');
  });

  it('prevents overlapping cycles and retries the same page after enumeration fails', async () => {
    const firstList = deferred<{ links: readonly EscrowPeriodicReconciliationLink[]; nextCursor: string | null }>();
    const listInputs: Array<{ cursor: string | null; limit: number }> = [];
    let listAttempt = 0;
    const { log, events } = logger();
    const runner = createEscrowPeriodicReconciliationRunner({
      links: {
        async listReconciliationLinks(input) {
          listInputs.push(input);
          listAttempt += 1;
          if (listAttempt === 1) return firstList.promise;
          if (listAttempt === 2) throw new Error('database details must not be logged');
          return { links: [], nextCursor: null };
        },
      },
      reconciler: { reconcile: async () => ({ status: 'in_sync' }) },
      batchSize: 5,
      intervalMs: 1_000,
      log,
    });

    const first = runner.runOnce();
    const overlapping = runner.runOnce();
    expect(runner.unfinished()).toBe(1);
    expect(listInputs).toHaveLength(1);
    firstList.resolve({ links: [], nextCursor: 'next-page' });
    await Promise.all([first, overlapping]);

    await expect(runner.runOnce()).resolves.toEqual({
      attempted: 0,
      succeeded: 0,
      failed: 0,
      sweepComplete: false,
    });
    await runner.runOnce();

    expect(listInputs).toEqual([
      { cursor: null, limit: 5 },
      { cursor: 'next-page', limit: 5 },
      { cursor: 'next-page', limit: 5 },
    ]);
    expect(events).toContainEqual({
      level: 'warn',
      event: 'escrow_periodic_reconciliation_list_failed',
      fields: { code: 'list_failed' },
    });
    expect(JSON.stringify(events)).not.toContain('database details');
  });

  it('stops scheduling and drains the active startup batch without abandoning it', async () => {
    vi.useFakeTimers();
    const pending = deferred<{ status: 'in_sync' }>();
    let listCount = 0;
    const { log } = logger();
    const runner = createEscrowPeriodicReconciliationRunner({
      links: {
        async listReconciliationLinks() {
          listCount += 1;
          return { links: links.slice(0, 1), nextCursor: null };
        },
      },
      reconciler: { reconcile: async () => pending.promise },
      batchSize: 1,
      intervalMs: 1_000,
      log,
    });

    runner.start();
    await vi.waitFor(() => expect(runner.unfinished()).toBe(1));
    runner.stopLeasing();
    const drained = runner.drain(new AbortController().signal);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(listCount).toBe(1);
    expect(runner.unfinished()).toBe(1);

    pending.resolve({ status: 'in_sync' });
    await drained;
    expect(runner.unfinished()).toBe(0);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(listCount).toBe(1);
  });

  it('rejects unsafe cadence and batch configuration', () => {
    const { log } = logger();
    const base = {
      links: { listReconciliationLinks: async () => ({ links: [], nextCursor: null }) },
      reconciler: { reconcile: async () => ({ status: 'in_sync' as const }) },
      log,
    };

    expect(() => createEscrowPeriodicReconciliationRunner({
      ...base,
      batchSize: 0,
      intervalMs: 1_000,
    })).toThrow(TypeError);
    expect(() => createEscrowPeriodicReconciliationRunner({
      ...base,
      batchSize: 1,
      intervalMs: Number.NaN,
    })).toThrow(TypeError);
  });
});
