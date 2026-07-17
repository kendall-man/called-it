import { describe, expect, it } from 'vitest';
import {
  CONCIERGE_READINESS_REASONS,
  createConciergeReadiness,
  type ReadinessDeadlinePort,
} from './readiness.js';

const NEVER_EXPIRES: ReadinessDeadlinePort = {
  wait: async () => new Promise<void>(() => undefined),
};

describe('concierge readiness', () => {
  it('maps invalid runtime configuration to a stable reason without raw detail', async () => {
    const readiness = createConciergeReadiness({
      runtime: {
        probe: async () => {
          throw new Error('secret configuration detail');
        },
      },
      engine: { probe: async () => 'ready' },
      runtimeTimeoutMs: 100,
      engineTimeoutMs: 100,
      deadline: NEVER_EXPIRES,
      drain: { isDraining: () => false },
    });

    const report = await readiness.evaluate();

    expect(report).toEqual({
      status: 'not_ready',
      reasons: [CONCIERGE_READINESS_REASONS.runtimeConfigurationInvalid],
    });
    expect(JSON.stringify(report)).not.toContain('secret');
  });

  it('bounds a hung runtime probe with an injected deadline', async () => {
    const waits: number[] = [];
    let expire: (() => void) | undefined;
    let runtimeSignal: AbortSignal | undefined;
    const readiness = createConciergeReadiness({
      runtime: {
        probe: (signal) => {
          runtimeSignal = signal;
          return new Promise<never>(() => undefined);
        },
      },
      engine: { probe: async () => 'ready' },
      runtimeTimeoutMs: 125,
      engineTimeoutMs: 250,
      deadline: {
        wait: (timeoutMs) => {
          waits.push(timeoutMs);
          return new Promise<void>((resolve) => {
            expire = resolve;
          });
        },
      },
      drain: { isDraining: () => false },
    });

    const reportPromise = readiness.evaluate();

    expect(waits).toEqual([125]);
    expire?.();
    expect(await reportPromise).toEqual({
      status: 'not_ready',
      reasons: [CONCIERGE_READINESS_REASONS.runtimeTimeout],
    });
    expect(runtimeSignal?.aborted).toBe(true);
  });

  it('reports engine_not_ready when the private engine readiness contract is red', async () => {
    let engineCalls = 0;
    const readiness = createConciergeReadiness({
      runtime: { probe: async () => undefined },
      engine: {
        probe: async () => {
          engineCalls += 1;
          return 'not_ready';
        },
      },
      runtimeTimeoutMs: 100,
      engineTimeoutMs: 100,
      deadline: NEVER_EXPIRES,
      drain: { isDraining: () => false },
    });

    const report = await readiness.evaluate();

    expect(engineCalls).toBe(1);
    expect(report).toEqual({
      status: 'not_ready',
      reasons: [CONCIERGE_READINESS_REASONS.engineNotReady],
    });
  });

  it('reports engine_timeout when the private engine readiness probe hangs', async () => {
    const waits: number[] = [];
    let expireEngine: (() => void) | undefined;
    let engineSignal: AbortSignal | undefined;
    let engineRegistered: (() => void) | undefined;
    const engineDeadlineRegistered = new Promise<void>((resolve) => {
      engineRegistered = resolve;
    });
    const readiness = createConciergeReadiness({
      runtime: { probe: async () => undefined },
      engine: {
        probe: (signal) => {
          engineSignal = signal;
          return new Promise<never>(() => undefined);
        },
      },
      runtimeTimeoutMs: 50,
      engineTimeoutMs: 250,
      deadline: {
        wait: (timeoutMs) => {
          waits.push(timeoutMs);
          if (timeoutMs === 250) {
            return new Promise<void>((resolve) => {
              expireEngine = resolve;
              engineRegistered?.();
            });
          }
          return new Promise<void>(() => undefined);
        },
      },
      drain: { isDraining: () => false },
    });

    const reportPromise = readiness.evaluate();
    await engineDeadlineRegistered;

    expect(waits).toEqual([50, 250]);
    expireEngine?.();
    expect(await reportPromise).toEqual({
      status: 'not_ready',
      reasons: [CONCIERGE_READINESS_REASONS.engineTimeout],
    });
    expect(engineSignal?.aborted).toBe(true);
  });

  it('maps engine transport failure to engine_unavailable without raw detail', async () => {
    const readiness = createConciergeReadiness({
      runtime: { probe: async () => undefined },
      engine: {
        probe: async () => {
          throw new Error('private engine transport secret');
        },
      },
      runtimeTimeoutMs: 100,
      engineTimeoutMs: 100,
      deadline: NEVER_EXPIRES,
      drain: { isDraining: () => false },
    });

    const report = await readiness.evaluate();

    expect(report).toEqual({
      status: 'not_ready',
      reasons: [CONCIERGE_READINESS_REASONS.engineUnavailable],
    });
    expect(JSON.stringify(report)).not.toContain('secret');
  });

  it('reports draining without calling runtime or engine probes', async () => {
    let calls = 0;
    const readiness = createConciergeReadiness({
      runtime: {
        probe: async () => {
          calls += 1;
        },
      },
      engine: {
        probe: async () => {
          calls += 1;
          return 'ready';
        },
      },
      runtimeTimeoutMs: 100,
      engineTimeoutMs: 100,
      deadline: NEVER_EXPIRES,
      drain: { isDraining: () => true },
    });

    const report = await readiness.evaluate();

    expect(report).toEqual({
      status: 'not_ready',
      reasons: [CONCIERGE_READINESS_REASONS.draining],
    });
    expect(calls).toBe(0);
  });

  it('reports engine_contract_invalid instead of accepting malformed readiness', async () => {
    const readiness = createConciergeReadiness({
      runtime: { probe: async () => undefined },
      engine: { probe: async () => 'invalid' },
      runtimeTimeoutMs: 100,
      engineTimeoutMs: 100,
      deadline: NEVER_EXPIRES,
      drain: { isDraining: () => false },
    });

    const report = await readiness.evaluate();

    expect(report).toEqual({
      status: 'not_ready',
      reasons: [CONCIERGE_READINESS_REASONS.engineContractInvalid],
    });
  });

  it('does not publish a stale ready result when draining starts during a probe', async () => {
    let finishRuntime: (() => void) | undefined;
    let draining = false;
    let engineCalls = 0;
    const readiness = createConciergeReadiness({
      runtime: {
        probe: async () =>
          new Promise<void>((resolve) => {
            finishRuntime = resolve;
          }),
      },
      engine: {
        probe: async () => {
          engineCalls += 1;
          return 'ready';
        },
      },
      runtimeTimeoutMs: 100,
      engineTimeoutMs: 100,
      deadline: NEVER_EXPIRES,
      drain: { isDraining: () => draining },
    });

    const reportPromise = readiness.evaluate();
    draining = true;
    finishRuntime?.();

    expect(await reportPromise).toEqual({
      status: 'not_ready',
      reasons: [CONCIERGE_READINESS_REASONS.draining],
    });
    expect(engineCalls).toBe(0);
  });
});
