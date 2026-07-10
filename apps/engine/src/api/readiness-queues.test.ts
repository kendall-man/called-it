import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGINE_READINESS_POLICY } from './readiness-checks.js';
import {
  READINESS_TEST_NOW,
  evaluateReadinessPorts,
  healthyReadinessPorts,
} from './readiness-checks.fixture.js';
import { ENGINE_READINESS_REASONS } from './readiness.js';

describe('engine readiness queue checks', () => {
  it('reports disabled proof submission without failing readiness', async () => {
    const ports = healthyReadinessPorts();
    const result = await evaluateReadinessPorts({
      ...ports,
      proof: {
        snapshot: async () => ({
          enabled: false,
          heartbeatAtMs: null,
          backlog: 0,
          oldestAgeMs: null,
        }),
      },
    });

    expect(result).toEqual({
      status: 'ready',
      reasons: [ENGINE_READINESS_REASONS.proofSubmissionDisabled],
    });
  });

  it('reports proof_worker_unavailable when enabled without a heartbeat', async () => {
    const ports = healthyReadinessPorts();
    const result = await evaluateReadinessPorts({
      ...ports,
      proof: {
        snapshot: async () => ({
          enabled: true,
          heartbeatAtMs: null,
          backlog: 0,
          oldestAgeMs: null,
        }),
      },
    });

    expect(result).toEqual({
      status: 'not_ready',
      reasons: [ENGINE_READINESS_REASONS.proofWorkerUnavailable],
    });
  });

  it('reports proof_worker_stale when its heartbeat exceeds the age budget', async () => {
    const ports = healthyReadinessPorts();
    const result = await evaluateReadinessPorts({
      ...ports,
      proof: {
        snapshot: async () => ({
          enabled: true,
          heartbeatAtMs:
            READINESS_TEST_NOW - DEFAULT_ENGINE_READINESS_POLICY.workerMaxAgeMs - 1,
          backlog: 0,
          oldestAgeMs: null,
        }),
      },
    });

    expect(result).toEqual({
      status: 'not_ready',
      reasons: [ENGINE_READINESS_REASONS.proofWorkerStale],
    });
  });

  it('reports proof_backlog when queued work exceeds the configured maximum', async () => {
    const ports = healthyReadinessPorts();
    const result = await evaluateReadinessPorts({
      ...ports,
      proof: {
        snapshot: async () => ({
          enabled: true,
          heartbeatAtMs: READINESS_TEST_NOW,
          backlog: DEFAULT_ENGINE_READINESS_POLICY.proofMaxBacklog + 1,
          oldestAgeMs: null,
        }),
      },
    });

    expect(result).toEqual({
      status: 'not_ready',
      reasons: [ENGINE_READINESS_REASONS.proofBacklog],
    });
  });

  it('reports proof_oldest_stale when the oldest job exceeds its age budget', async () => {
    const ports = healthyReadinessPorts();
    const result = await evaluateReadinessPorts({
      ...ports,
      proof: {
        snapshot: async () => ({
          enabled: true,
          heartbeatAtMs: READINESS_TEST_NOW,
          backlog: 1,
          oldestAgeMs: DEFAULT_ENGINE_READINESS_POLICY.proofMaxOldestAgeMs + 1,
        }),
      },
    });

    expect(result).toEqual({
      status: 'not_ready',
      reasons: [ENGINE_READINESS_REASONS.proofOldestStale],
    });
  });

  it('reports disabled settlement reconciliation without failing readiness', async () => {
    const ports = healthyReadinessPorts();
    const result = await evaluateReadinessPorts({
      ...ports,
      settlement: {
        snapshot: async () => ({
          enabled: false,
          heartbeatAtMs: null,
          backlog: 0,
          oldestAgeMs: null,
        }),
      },
    });

    expect(result).toEqual({
      status: 'ready',
      reasons: [ENGINE_READINESS_REASONS.settlementReconciliationDisabled],
    });
  });

  it('reports settlement_worker_unavailable when enabled without a heartbeat', async () => {
    const ports = healthyReadinessPorts();
    const result = await evaluateReadinessPorts({
      ...ports,
      settlement: {
        snapshot: async () => ({
          enabled: true,
          heartbeatAtMs: null,
          backlog: 0,
          oldestAgeMs: null,
        }),
      },
    });

    expect(result).toEqual({
      status: 'not_ready',
      reasons: [ENGINE_READINESS_REASONS.settlementWorkerUnavailable],
    });
  });

  it('reports settlement_worker_stale when its heartbeat exceeds the age budget', async () => {
    const ports = healthyReadinessPorts();
    const result = await evaluateReadinessPorts({
      ...ports,
      settlement: {
        snapshot: async () => ({
          enabled: true,
          heartbeatAtMs:
            READINESS_TEST_NOW - DEFAULT_ENGINE_READINESS_POLICY.workerMaxAgeMs - 1,
          backlog: 0,
          oldestAgeMs: null,
        }),
      },
    });

    expect(result).toEqual({
      status: 'not_ready',
      reasons: [ENGINE_READINESS_REASONS.settlementWorkerStale],
    });
  });

  it('reports settlement_backlog when queued work exceeds the configured maximum', async () => {
    const ports = healthyReadinessPorts();
    const result = await evaluateReadinessPorts({
      ...ports,
      settlement: {
        snapshot: async () => ({
          enabled: true,
          heartbeatAtMs: READINESS_TEST_NOW,
          backlog: DEFAULT_ENGINE_READINESS_POLICY.settlementMaxBacklog + 1,
          oldestAgeMs: null,
        }),
      },
    });

    expect(result).toEqual({
      status: 'not_ready',
      reasons: [ENGINE_READINESS_REASONS.settlementBacklog],
    });
  });

  it('reports settlement_oldest_stale when the oldest job exceeds its age budget', async () => {
    const ports = healthyReadinessPorts();
    const result = await evaluateReadinessPorts({
      ...ports,
      settlement: {
        snapshot: async () => ({
          enabled: true,
          heartbeatAtMs: READINESS_TEST_NOW,
          backlog: 1,
          oldestAgeMs: DEFAULT_ENGINE_READINESS_POLICY.settlementMaxOldestAgeMs + 1,
        }),
      },
    });

    expect(result).toEqual({
      status: 'not_ready',
      reasons: [ENGINE_READINESS_REASONS.settlementOldestStale],
    });
  });
});
