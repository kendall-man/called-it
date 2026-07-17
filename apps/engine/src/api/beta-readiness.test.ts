import { describe, expect, it } from 'vitest';
import { createBetaReadinessPorts } from './beta-readiness.js';
import {
  READINESS_TEST_NOW,
  evaluateReadinessPorts,
  healthyReadinessPorts,
} from './readiness-checks.fixture.js';
import { DEFAULT_ENGINE_READINESS_POLICY } from './readiness-checks.js';
import { ENGINE } from '../engineConstants.js';

describe('beta readiness', () => {
  it('refreshes settlement health before the worker heartbeat can become stale', () => {
    expect(ENGINE.SETTLEMENT_RECONCILIATION_MS).toBeLessThan(
      DEFAULT_ENGINE_READINESS_POLICY.workerMaxAgeMs,
    );
  });

  it('treats healthy score reconciliation as ready and proof submission as intentionally disabled', async () => {
    const healthy = healthyReadinessPorts();
    const { telegram, ...base } = healthy;
    const ports = createBetaReadinessPorts({
      base,
      feed: {
        snapshot: async () => ({
          activePricingExpected: true,
          lastEventAtMs: READINESS_TEST_NOW,
        }),
      },
      settlement: {
        snapshot: async () => ({
          enabled: true,
          heartbeatAtMs: READINESS_TEST_NOW,
          backlog: 0,
          oldestAgeMs: null,
        }),
      },
    });

    await expect(evaluateReadinessPorts({ ...ports, telegram })).resolves.toEqual({
      status: 'ready',
      reasons: ['proof_submission_disabled'],
    });
  });
});
