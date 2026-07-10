import { describe, expect, it } from 'vitest';
import { DrainState } from './readiness.js';
import {
  createShutdownSignalHandler,
  runBoundedShutdown,
  type ShutdownDeadlinePort,
  type ShutdownDrainPort,
} from './shutdown.js';

describe('bounded engine shutdown', () => {
  it('waits for a short leased job before returning a clean exit', async () => {
    let unfinished = 1;
    let finishJob: (() => void) | undefined;
    const order: string[] = [];
    const jobDrain = {
      name: 'leased_work',
      drain: async () => {
        order.push('drain');
        await new Promise<void>((resolve) => {
          finishJob = () => {
            unfinished = 0;
            resolve();
          };
        });
      },
      unfinished: () => unfinished,
    } satisfies ShutdownDrainPort;
    const drainState = new DrainState();
    const resultPromise = runBoundedShutdown({
      timeoutMs: 10_000,
      deadline: { wait: async () => new Promise<void>(() => undefined) },
      drainState,
      stopIntake: () => order.push('stop_intake'),
      closeResources: async () => {
        order.push('close_resources');
      },
      drains: [jobDrain],
    });
    await Promise.resolve();

    expect(order).toEqual(['stop_intake', 'close_resources', 'drain']);
    expect(drainState.isDraining()).toBe(true);
    finishJob?.();
    expect(await resultPromise).toEqual({
      exitCode: 0,
      timedOut: false,
      unfinishedCount: 0,
      unfinished: {},
    });
  });

  it('times out a hung drain and reports its unfinished count', async () => {
    const waits: number[] = [];
    let expire: (() => void) | undefined;
    let drainSignal: AbortSignal | undefined;
    const deadline: ShutdownDeadlinePort = {
      wait: (timeoutMs) => {
        waits.push(timeoutMs);
        return new Promise<void>((resolve) => {
          expire = resolve;
        });
      },
    };
    const leaseDrain = {
      name: 'leased_work',
      drain: (signal: AbortSignal) => {
        drainSignal = signal;
        return new Promise<never>(() => undefined);
      },
      unfinished: () => 3,
    } satisfies ShutdownDrainPort;
    const drainState = new DrainState();
    const resultPromise = runBoundedShutdown({
      timeoutMs: 10_000,
      deadline,
      drainState,
      stopIntake: () => undefined,
      closeResources: async () => undefined,
      drains: [leaseDrain],
    });

    expect(waits).toEqual([10_000]);
    expire?.();
    expect(await resultPromise).toEqual({
      exitCode: 1,
      timedOut: true,
      unfinishedCount: 3,
      unfinished: { leased_work: 3 },
    });
    expect(drainState.isDraining()).toBe(true);
    expect(drainSignal?.aborted).toBe(true);
  });

  it('returns non-zero when a drain rejects before the deadline', async () => {
    const failedDrain = {
      name: 'leased_work',
      drain: async () => {
        throw new Error('raw lease error');
      },
      unfinished: () => 1,
    } satisfies ShutdownDrainPort;

    const result = await runBoundedShutdown({
      timeoutMs: 10_000,
      deadline: { wait: async () => new Promise<void>(() => undefined) },
      drainState: new DrainState(),
      stopIntake: () => undefined,
      closeResources: async () => undefined,
      drains: [failedDrain],
    });

    expect(result).toEqual({
      exitCode: 1,
      timedOut: false,
      unfinishedCount: 1,
      unfinished: { leased_work: 1 },
    });
    expect(JSON.stringify(result)).not.toContain('raw lease error');
  });

  it('forces one non-zero exit when shutdown is interrupted repeatedly', async () => {
    let finish: ((result: {
      exitCode: 0;
      timedOut: false;
      unfinishedCount: 0;
      unfinished: Record<string, number>;
    }) => void) | undefined;
    const exits: number[] = [];
    const repeats: string[] = [];
    const handler = createShutdownSignalHandler({
      shutdown: async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      exit: (code) => exits.push(code),
      repeated: (signal) => repeats.push(signal),
    });

    handler('SIGTERM');
    handler('SIGINT');

    expect(repeats).toEqual(['SIGINT']);
    expect(exits).toEqual([1]);
    finish?.({
      exitCode: 0,
      timedOut: false,
      unfinishedCount: 0,
      unfinished: {},
    });
    await Promise.resolve();
    expect(exits).toEqual([1]);
  });
});
