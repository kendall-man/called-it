import { describe, expect, it } from 'vitest';
import { ConciergeLifecycle, createConciergeSignalController } from './lifecycle.js';

describe('concierge lifecycle', () => {
  it('rejects new intake and counts unfinished work after drain begins', async () => {
    let finish: (() => void) | undefined;
    const lifecycle = new ConciergeLifecycle();
    const work = lifecycle.track(
      async () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );

    expect(lifecycle.unfinished()).toBe(1);
    expect(lifecycle.beginDrain()).toBe(true);
    expect(lifecycle.isDraining()).toBe(true);
    expect(lifecycle.acceptsIntake()).toBe(false);
    finish?.();
    await work;
    expect(lifecycle.unfinished()).toBe(0);
    expect(lifecycle.beginDrain()).toBe(false);
  });

  it('does not invoke tracked work after drain has started', async () => {
    let called = false;
    const lifecycle = new ConciergeLifecycle();
    lifecycle.beginDrain();

    const work = lifecycle.track(async () => {
      called = true;
    });

    await expect(work).rejects.toThrowError('concierge_draining');
    expect(called).toBe(false);
    expect(lifecycle.unfinished()).toBe(0);
  });

  it('counts Eve sessions idempotently until terminal completion', () => {
    const lifecycle = new ConciergeLifecycle();

    expect(lifecycle.beginSession('session-1')).toBe(true);
    expect(lifecycle.beginSession('session-1')).toBe(false);
    expect(lifecycle.unfinished()).toBe(1);
    expect(lifecycle.finishSession('session-1')).toBe(true);
    expect(lifecycle.finishSession('session-1')).toBe(false);
    expect(lifecycle.unfinished()).toBe(0);
  });

  it('forces non-zero exit with unfinished count after the shutdown deadline', () => {
    const lifecycle = new ConciergeLifecycle();
    void lifecycle.track(async () => new Promise<never>(() => undefined));
    const schedules: number[] = [];
    let expire: (() => void) | undefined;
    const exits: number[] = [];
    const logs: Array<{
      event: string;
      fields: Readonly<Record<string, string | number>>;
    }> = [];
    const controller = createConciergeSignalController({
      lifecycle,
      timeoutMs: 12_000,
      schedule: (callback, timeoutMs) => {
        schedules.push(timeoutMs);
        expire = callback;
        return () => undefined;
      },
      exit: (code) => exits.push(code),
      log: (event, fields) => logs.push({ event, fields }),
    });

    controller.signal('SIGTERM');

    expect(lifecycle.isDraining()).toBe(true);
    expect(schedules).toEqual([12_000]);
    expire?.();
    expect(exits).toEqual([1]);
    expect(logs).toContainEqual({
      event: 'concierge_shutdown_timeout',
      fields: { signal: 'SIGTERM', unfinishedCount: 1 },
    });
  });

  it('forces one immediate non-zero exit on repeated interruption', () => {
    const exits: number[] = [];
    const logs: Array<{
      event: string;
      fields: Readonly<Record<string, string | number>>;
    }> = [];
    const controller = createConciergeSignalController({
      lifecycle: new ConciergeLifecycle(),
      timeoutMs: 12_000,
      schedule: () => () => undefined,
      exit: (code) => exits.push(code),
      log: (event, fields) => logs.push({ event, fields }),
    });

    controller.signal('SIGTERM');
    controller.signal('SIGINT');
    controller.signal('SIGINT');

    expect(exits).toEqual([1]);
    expect(logs).toContainEqual({
      event: 'concierge_shutdown_repeated_signal',
      fields: { signal: 'SIGINT', unfinishedCount: 0 },
    });
  });

  it('normalizes framework signal exit to clean after all work is drained', () => {
    const logs: Array<{
      event: string;
      fields: Readonly<Record<string, string | number>>;
    }> = [];
    const controller = createConciergeSignalController({
      lifecycle: new ConciergeLifecycle(),
      timeoutMs: 12_000,
      schedule: () => () => undefined,
      exit: () => undefined,
      log: (event, fields) => logs.push({ event, fields }),
    });

    controller.signal('SIGTERM');

    expect(controller.complete()).toBe(0);
    expect(controller.complete()).toBe(0);
    expect(logs).toContainEqual({
      event: 'concierge_shutdown_complete',
      fields: { signal: 'SIGTERM', unfinishedCount: 0 },
    });
  });

  it('keeps process exit non-zero when the framework closes with unfinished work', () => {
    const lifecycle = new ConciergeLifecycle();
    lifecycle.beginSession('session-1');
    const logs: Array<{
      event: string;
      fields: Readonly<Record<string, string | number>>;
    }> = [];
    const controller = createConciergeSignalController({
      lifecycle,
      timeoutMs: 12_000,
      schedule: () => () => undefined,
      exit: () => undefined,
      log: (event, fields) => logs.push({ event, fields }),
    });

    controller.signal('SIGTERM');

    expect(controller.complete()).toBe(1);
    expect(logs).toContainEqual({
      event: 'concierge_shutdown_failed',
      fields: { signal: 'SIGTERM', unfinishedCount: 1 },
    });
  });
});
