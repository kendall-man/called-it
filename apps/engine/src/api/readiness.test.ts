import { describe, expect, it } from 'vitest';
import {
  DrainState,
  ENGINE_READINESS_REASONS,
  createReadinessEvaluator,
  type ReadinessCheckPort,
  type ReadinessDeadlinePort,
} from './readiness.js';

const NEVER_EXPIRES: ReadinessDeadlinePort = {
  wait: async () => new Promise<void>(() => undefined),
};

describe('engine readiness evaluator', () => {
  it('returns the stable dependency reason when a check is not ready', async () => {
    const database = {
      name: 'database',
      unavailableReason: ENGINE_READINESS_REASONS.databaseUnavailable,
      timeoutReason: ENGINE_READINESS_REASONS.databaseTimeout,
      check: async () => ({
        kind: 'not_ready',
        reason: ENGINE_READINESS_REASONS.databaseUnavailable,
      }),
    } satisfies ReadinessCheckPort;
    const readiness = createReadinessEvaluator({
      checks: [database],
      checkTimeoutMs: 100,
      deadline: NEVER_EXPIRES,
      drainState: new DrainState(),
    });

    const report = await readiness.evaluate();

    expect(report).toEqual({
      status: 'not_ready',
      reasons: [ENGINE_READINESS_REASONS.databaseUnavailable],
    });
  });

  it('bounds a hung dependency with the injected deadline and aborts its check', async () => {
    const waits: number[] = [];
    let expire: (() => void) | undefined;
    let checkSignal: AbortSignal | undefined;
    const deadline: ReadinessDeadlinePort = {
      wait: (timeoutMs) => {
        waits.push(timeoutMs);
        return new Promise<void>((resolve) => {
          expire = resolve;
        });
      },
    };
    const database = {
      name: 'database',
      unavailableReason: ENGINE_READINESS_REASONS.databaseUnavailable,
      timeoutReason: ENGINE_READINESS_REASONS.databaseTimeout,
      check: (signal: AbortSignal) => {
        checkSignal = signal;
        return new Promise<never>(() => undefined);
      },
    } satisfies ReadinessCheckPort;
    const readiness = createReadinessEvaluator({
      checks: [database],
      checkTimeoutMs: 125,
      deadline,
      drainState: new DrainState(),
    });

    const reportPromise = readiness.evaluate();

    expect(waits).toEqual([125]);
    expire?.();
    expect(await reportPromise).toEqual({
      status: 'not_ready',
      reasons: [ENGINE_READINESS_REASONS.databaseTimeout],
    });
    expect(checkSignal?.aborted).toBe(true);
  });

  it('maps a thrown dependency error to its stable unavailable reason', async () => {
    const database = {
      name: 'database',
      unavailableReason: ENGINE_READINESS_REASONS.databaseUnavailable,
      timeoutReason: ENGINE_READINESS_REASONS.databaseTimeout,
      check: async () => {
        throw new Error('sensitive upstream detail');
      },
    } satisfies ReadinessCheckPort;
    const readiness = createReadinessEvaluator({
      checks: [database],
      checkTimeoutMs: 100,
      deadline: NEVER_EXPIRES,
      drainState: new DrainState(),
    });

    const report = await readiness.evaluate();

    expect(report).toEqual({
      status: 'not_ready',
      reasons: [ENGINE_READINESS_REASONS.databaseUnavailable],
    });
    expect(JSON.stringify(report)).not.toContain('sensitive');
  });

  it('reports draining immediately without calling dependencies', async () => {
    let calls = 0;
    const database = {
      name: 'database',
      unavailableReason: ENGINE_READINESS_REASONS.databaseUnavailable,
      timeoutReason: ENGINE_READINESS_REASONS.databaseTimeout,
      check: async () => {
        calls += 1;
        return { kind: 'ready' };
      },
    } satisfies ReadinessCheckPort;
    const drainState = new DrainState();
    drainState.begin();
    const readiness = createReadinessEvaluator({
      checks: [database],
      checkTimeoutMs: 100,
      deadline: NEVER_EXPIRES,
      drainState,
    });

    const report = await readiness.evaluate();

    expect(report).toEqual({
      status: 'not_ready',
      reasons: [ENGINE_READINESS_REASONS.draining],
    });
    expect(calls).toBe(0);
  });

  it('does not publish a stale ready result when draining starts during a check', async () => {
    let finishCheck: (() => void) | undefined;
    const database = {
      name: 'database',
      unavailableReason: ENGINE_READINESS_REASONS.databaseUnavailable,
      timeoutReason: ENGINE_READINESS_REASONS.databaseTimeout,
      check: async () =>
        new Promise<{ kind: 'ready' }>((resolve) => {
          finishCheck = () => resolve({ kind: 'ready' });
        }),
    } satisfies ReadinessCheckPort;
    const drainState = new DrainState();
    const readiness = createReadinessEvaluator({
      checks: [database],
      checkTimeoutMs: 100,
      deadline: NEVER_EXPIRES,
      drainState,
    });

    const reportPromise = readiness.evaluate();
    drainState.begin();
    finishCheck?.();

    expect(await reportPromise).toEqual({
      status: 'not_ready',
      reasons: [ENGINE_READINESS_REASONS.draining],
    });
  });
});
