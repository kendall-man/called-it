import { describe, expect, it } from 'vitest';
import { DrainState } from './api/readiness.js';
import { runBoundedShutdown } from './api/shutdown.js';
import type { OwnedPoster } from './bot/poster.js';
import { loadEnv } from './env.js';
import { BASE_ENV } from './env.test-fixtures.js';
import { MemorySettlementProofJobs } from './settle/recovery.test-support.js';
import { createEngineRuntime } from './runtime.js';
import {
  RUNTIME_TEST_NOW,
  RUNTIME_TEST_WORKER_ID,
  createRuntimeTelegramFacade,
  silentLogger,
  unusedOutbox,
} from './runtime.test-support.js';
import { createDeps } from './wiring.js';

const MARKET_ID = '11111111-1111-4111-8111-111111111111';

describe('engine durable runtime composition', () => {
  it('constructs the production durable facades without direct credentials', async () => {
    const deps = await createDeps(loadEnv(BASE_ENV), silentLogger());

    expect(deps.proofSubmitter).toBeNull();
    expect(deps.runtime.proofSubmission).toBeNull();
    expect(typeof deps.runtime.settlementJobs.recordTerminalSettlement).toBe('function');
    expect(typeof deps.runtime.proofOutbox.prepare).toBe('function');
    expect(typeof deps.runtime.telegram.persistUpdate).toBe('function');
  });

  it('leases persisted work, reports live queues, and drains durable workers', async () => {
    const jobs = new MemorySettlementProofJobs();
    const trace: string[] = [];
    const telegram = createRuntimeTelegramFacade(trace);
    let configured = false;
    const runtime = createEngineRuntime({
      jobs,
      proofSubmissionOutbox: unusedOutbox(),
      telegram,
      facts: {
        async find(marketId) {
          return marketId === MARKET_ID
            ? {
                marketId,
                fixtureId: 4,
                outcome: 'void',
                tier: 'oracle_resolved',
                decidingSeq: null,
                comparator: 'gte',
                threshold: 1,
                statKey: null,
              }
            : null;
        },
      },
      effects: {
        async apply(marketId) {
          trace.push(`effects:${marketId}`);
        },
      },
      receipts: {
        async deliver(fact) {
          trace.push(`receipt:${fact.marketId}`);
          return 'delivered';
        },
      },
      tx: { fetchStatProof: async () => undefined },
      proofSubmission: null,
      roots: { rootsFor: async () => null },
      marketEvidence: { getMarket: async () => null },
      poster: {
        configureOutboundOwnership() {
          configured = true;
        },
      } satisfies Pick<OwnedPoster, 'configureOutboundOwnership'>,
      clock: { now: () => RUNTIME_TEST_NOW },
      policy: {
        maxAttempts: 3,
        leaseMs: 10_000,
        retryBaseMs: 100,
        retryMaxMs: 1_000,
        initialChainProofDelayMs: 100,
        batchSize: 5,
        reconcileLimit: 10,
      },
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      workerId: RUNTIME_TEST_WORKER_ID,
      settlementEnabled: true,
      ingressHandler: async (payload) => {
        trace.push(`ingress:${String(payload.update_id)}`);
      },
    });

    const journal = runtime.journal;
    if (journal === null) throw new Error('durable settlement journal was not configured');
    await journal.recordTerminal({
      marketId: MARKET_ID,
      outcome: 'void',
      decidingSeq: null,
      evidenceSeqs: [],
      tier: 'oracle_resolved',
    });

    expect(configured).toBe(true);
    await expect(runtime.readiness.settlement.snapshot(new AbortController().signal)).resolves.toMatchObject({
      enabled: true,
      heartbeatAtMs: null,
      backlog: 1,
    });

    await runtime.tick();

    expect(trace).toEqual(expect.arrayContaining([
      'ingress:7',
      `effects:${MARKET_ID}`,
      `receipt:${MARKET_ID}`,
      'complete_update:update-7',
    ]));
    expect(jobs.job(MARKET_ID, 'settlement').status).toBe('complete');
    expect(jobs.job(MARKET_ID, 'proof').status).toBe('complete');
    await expect(runtime.readiness.settlement.snapshot(new AbortController().signal)).resolves.toMatchObject({
      enabled: true,
      heartbeatAtMs: RUNTIME_TEST_NOW,
      backlog: 0,
    });
    await expect(runtime.readiness.proof.snapshot(new AbortController().signal)).resolves.toMatchObject({
      enabled: false,
      heartbeatAtMs: RUNTIME_TEST_NOW,
      backlog: 0,
    });
    await expect(runtime.readiness.telegram.snapshot(new AbortController().signal)).resolves.toEqual({
      heartbeatAtMs: RUNTIME_TEST_NOW,
    });
    expect(runtime.shutdownDrains().map((drain) => drain.name)).toEqual([
      'durable_settlement_proof',
      'telegram_outbound_ownership',
      'telegram_outbound_completion',
      'telegram_ownership_reconciler',
      'telegram_ingress',
    ]);

    const result = await runBoundedShutdown({
      timeoutMs: 100,
      deadline: { wait: async () => new Promise<void>(() => undefined) },
      drainState: new DrainState(),
      stopIntake: () => runtime.stop(),
      closeResources: async () => undefined,
      drains: runtime.shutdownDrains(),
    });

    expect(result).toEqual({
      exitCode: 0,
      timedOut: false,
      unfinishedCount: 0,
      unfinished: {},
    });
    expect(trace).toContain('sweep_outbound');
  });
});
