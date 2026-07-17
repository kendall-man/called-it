import {
  DEFAULT_ENGINE_READINESS_POLICY,
  createEngineReadinessChecks,
  type EngineReadinessPorts,
} from './readiness-checks.js';
import { DrainState, createReadinessEvaluator } from './readiness.js';

export const READINESS_TEST_NOW = Date.parse('2026-07-10T00:00:00.000Z');

export function healthyReadinessPorts(): EngineReadinessPorts {
  return {
    database: { probe: async () => undefined },
    feed: {
      snapshot: async () => ({
        activePricingExpected: true,
        lastEventAtMs: READINESS_TEST_NOW,
      }),
    },
    wager: {
      snapshot: async () => ({
        enabled: true,
        configured: true,
        paused: false,
        covered: true,
      }),
    },
    telegram: { snapshot: async () => ({ heartbeatAtMs: READINESS_TEST_NOW }) },
    proof: {
      snapshot: async () => ({
        enabled: true,
        heartbeatAtMs: READINESS_TEST_NOW,
        backlog: 0,
        deadCount: 0,
        oldestAgeMs: null,
      }),
    },
    settlement: {
      snapshot: async () => ({
        enabled: true,
        heartbeatAtMs: READINESS_TEST_NOW,
        backlog: 0,
        deadCount: 0,
        oldestAgeMs: null,
      }),
    },
  };
}

export async function evaluateReadinessPorts(ports: EngineReadinessPorts) {
  const checks = createEngineReadinessChecks(
    ports,
    DEFAULT_ENGINE_READINESS_POLICY,
    () => READINESS_TEST_NOW,
  );
  const readiness = createReadinessEvaluator({
    checks,
    checkTimeoutMs: DEFAULT_ENGINE_READINESS_POLICY.checkTimeoutMs,
    deadline: { wait: async () => new Promise<void>(() => undefined) },
    drainState: new DrainState(),
  });
  return readiness.evaluate();
}
