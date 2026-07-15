import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEscrowRuntimeLifecycle } from './runtime-lifecycle.js';

afterEach(() => vi.useRealTimers());

describe('escrow runtime lifecycle', () => {
  it('runs recovery before indexing and never overlaps scheduled cycles', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let release: (() => void) | undefined;
    const firstRelayer = new Promise<void>((resolve) => { release = resolve; });
    let relayerRuns = 0;
    const lifecycle = createEscrowRuntimeLifecycle({
      relayer: {
        async runOnce() {
          calls.push('relayer');
          relayerRuns += 1;
          if (relayerRuns === 1) await firstRelayer;
        },
      },
      indexer: { async runOnce() { calls.push('indexer'); } },
      clock: () => '2026-07-15T00:00:00.000Z',
      intervalMs: 1_000,
      relayerLimit: 10,
      indexerLimit: 20,
      log: { info() {}, error() {} },
    });

    lifecycle.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toEqual(['relayer']);
    expect(lifecycle.unfinished()).toBe(1);

    release?.();
    await firstRelayer;
    await vi.runOnlyPendingTimersAsync();
    expect(calls.slice(0, 3)).toEqual(['relayer', 'indexer', 'relayer']);
    await lifecycle.stop();
    expect(lifecycle.unfinished()).toBe(0);
  });

  it('continues indexing when a relayer cycle fails and stops cleanly', async () => {
    const errors: Readonly<Record<string, unknown>>[] = [];
    const lifecycle = createEscrowRuntimeLifecycle({
      relayer: { async runOnce() { throw new Error('rpc unavailable'); } },
      indexer: { async runOnce() {} },
      clock: () => '2026-07-15T00:00:00.000Z',
      intervalMs: 1_000,
      relayerLimit: 10,
      indexerLimit: 20,
      log: { info() {}, error(_event, fields) { errors.push(fields ?? {}); } },
    });

    await lifecycle.runOnce();
    expect(errors).toEqual([{ worker: 'relayer', reason: 'Error' }]);
    await lifecycle.stop();
  });
});
