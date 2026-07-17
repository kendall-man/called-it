import { describe, expect, it, vi } from 'vitest';
import { createEscrowReadinessHealthCheck } from './readiness-health.js';

describe('escrow readiness health check', () => {
  it('single-flights probes and caches the bounded result', async () => {
    let now = 1_000;
    let resolveProbe: ((value: { status: 'ready'; reasons: [] }) => void) | undefined;
    const readiness = vi.fn(() => new Promise<{ status: 'ready'; reasons: [] }>((resolve) => {
      resolveProbe = resolve;
    }));
    const log = { info: vi.fn(), warn: vi.fn() };
    const health = createEscrowReadinessHealthCheck({
      readiness,
      now: () => now,
      cacheTtlMs: 10_000,
      failureCacheTtlMs: 1_000,
      probeTimeoutMs: 5_000,
      log,
    });
    const signal = new AbortController().signal;

    const first = health.check(signal);
    const second = health.check(signal);
    expect(readiness).toHaveBeenCalledTimes(1);
    resolveProbe?.({ status: 'ready', reasons: [] });
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);

    now += 9_999;
    await expect(health.check(signal)).resolves.toBe(true);
    expect(readiness).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  it('refreshes at expiry and logs only readiness transitions', async () => {
    let now = 1_000;
    const reports = [
      { status: 'not_ready' as const, reasons: ['indexer_lagging' as const] },
      { status: 'not_ready' as const, reasons: ['indexer_lagging' as const] },
      { status: 'ready' as const, reasons: [] as const },
    ];
    const readiness = vi.fn(async () => reports.shift()!);
    const log = { info: vi.fn(), warn: vi.fn() };
    const health = createEscrowReadinessHealthCheck({
      readiness,
      now: () => now,
      cacheTtlMs: 10,
      failureCacheTtlMs: 10,
      probeTimeoutMs: 5_000,
      log,
    });
    const signal = new AbortController().signal;

    await expect(health.check(signal)).resolves.toBe(false);
    now += 10;
    await expect(health.check(signal)).resolves.toBe(false);
    now += 10;
    await expect(health.check(signal)).resolves.toBe(true);

    expect(readiness).toHaveBeenCalledTimes(3);
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith('escrow_readiness_unavailable', {
      reasons: ['indexer_lagging'],
    });
    expect(log.info).toHaveBeenCalledOnce();
  });

  it('does not return a cached result to an aborted caller', async () => {
    const health = createEscrowReadinessHealthCheck({
      readiness: async () => ({ status: 'ready', reasons: [] }),
      now: () => 1_000,
      cacheTtlMs: 10,
      failureCacheTtlMs: 10,
      probeTimeoutMs: 5_000,
      log: { info: vi.fn(), warn: vi.fn() },
    });
    const controller = new AbortController();
    await expect(health.check(controller.signal)).resolves.toBe(true);
    controller.abort();
    await expect(health.check(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('isolates caller cancellation from the shared probe', async () => {
    let resolveProbe: ((value: { status: 'ready'; reasons: [] }) => void) | undefined;
    const health = createEscrowReadinessHealthCheck({
      readiness: async () => new Promise<{ status: 'ready'; reasons: [] }>((resolve) => {
        resolveProbe = resolve;
      }),
      now: () => 1_000,
      cacheTtlMs: 10,
      failureCacheTtlMs: 10,
      probeTimeoutMs: 5_000,
      log: { info: vi.fn(), warn: vi.fn() },
    });
    const cancelled = new AbortController();
    const first = health.check(cancelled.signal);
    const second = health.check(new AbortController().signal);

    cancelled.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    resolveProbe?.({ status: 'ready', reasons: [] });
    await expect(second).resolves.toBe(true);
  });

  it('bounds a non-settling probe and retries after the short failure cache', async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const readiness = vi.fn(async () => new Promise<never>(() => undefined));
    const health = createEscrowReadinessHealthCheck({
      readiness,
      now: () => now,
      cacheTtlMs: 10_000,
      failureCacheTtlMs: 100,
      probeTimeoutMs: 50,
      log: { info: vi.fn(), warn: vi.fn() },
    });
    const signal = new AbortController().signal;

    const first = health.check(signal);
    await vi.advanceTimersByTimeAsync(50);
    await expect(first).resolves.toBe(false);
    now += 100;
    const second = health.check(signal);
    expect(readiness).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(50);
    await expect(second).resolves.toBe(false);
    vi.useRealTimers();
  });
});
