import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ENGINE_READINESS_POLICY,
  createEngineReadinessChecks,
} from './readiness-checks.js';
import {
  READINESS_TEST_NOW,
  healthyReadinessPorts,
} from './readiness-checks.fixture.js';
import { DrainState, createReadinessEvaluator } from './readiness.js';
import { makeFakeDeps } from '../wager/fakes.js';
import { starterOnlyWagerDbFromFake } from '../wager/starter-fake.test-support.js';
import { createStarterOnlyWagerModule } from '../wager/starter-only-module.js';
import {
  CHAT_ID,
  USER_ID,
  authed,
  closeActiveServer,
  startHarness,
} from './server-test-harness.js';

afterEach(closeActiveServer);

function createDisabledStagingReadiness() {
  const ports = healthyReadinessPorts();
  return createReadinessEvaluator({
    checks: createEngineReadinessChecks(
      {
        ...ports,
        feed: {
          snapshot: async () => ({ activePricingExpected: false, lastEventAtMs: null }),
        },
        wager: {
          snapshot: async () => ({
              enabled: false,
              configured: false,
              runtimeMatches: true,
              paused: false,
              covered: false,
              starterIntakeReady: false,
          }),
        },
        proof: {
          snapshot: async () => ({
            enabled: false,
            heartbeatAtMs: null,
            backlog: 0,
            oldestAgeMs: null,
          }),
        },
        settlement: {
          snapshot: async () => ({
            enabled: false,
            heartbeatAtMs: null,
            backlog: 0,
            oldestAgeMs: null,
          }),
        },
      },
      DEFAULT_ENGINE_READINESS_POLICY,
      () => READINESS_TEST_NOW,
    ),
    checkTimeoutMs: DEFAULT_ENGINE_READINESS_POLICY.checkTimeoutMs,
    deadline: { wait: async () => new Promise<void>(() => undefined) },
    drainState: new DrainState(),
  });
}

describe('engine API with wager safely disabled', () => {
  it('keeps liveness and readiness up while disabled capabilities stay explicit', async () => {
    const harness = await startHarness({
      wager: null,
      readiness: createDisabledStagingReadiness(),
    });

    const live = await fetch(`${harness.base}/api/live`);
    const ready = await fetch(`${harness.base}/api/ready`);

    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'live' });
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({
      status: 'ready',
      reasons: [
        'feed_inactive',
        'wager_disabled',
        'proof_submission_disabled',
        'settlement_reconciliation_disabled',
      ],
    });
  });

  it('fails wallet surfaces and removed write routes closed when wager is absent', async () => {
    const harness = await startHarness({
      wager: null,
      readiness: createDisabledStagingReadiness(),
    });

    const wallet = await fetch(
      `${harness.base}/api/groups/${CHAT_ID}/users/${USER_ID}/wallet`,
      { headers: authed },
    );
    const walletWrite = await fetch(
      `${harness.base}/api/groups/${CHAT_ID}/users/${USER_ID}/wallet`,
      {
        method: 'POST',
        headers: authed,
        body: JSON.stringify({ pubkey: 'RawWalletPubkey111111111111111111111111111' }),
      },
    );
    const stake = await fetch(`${harness.base}/api/stake`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({}),
    });

    expect(wallet.status).toBe(503);
    expect(await wallet.json()).toEqual({ error: 'wager_unavailable' });
    expect(walletWrite.status).toBe(404);
    expect(stake.status).toBe(404);
  });

  it('returns 404 for wallet reads when starter-only is constructed', async () => {
    // Given the DB-only starter runtime is active
    const { db, deps } = makeFakeDeps();
    const wager = createStarterOnlyWagerModule({
      runtimeMode: 'starter_only',
      db: starterOnlyWagerDbFromFake(db),
      log: deps.log,
      starterGrantsEnabled: true,
      stakeAcceptanceEnabled: true,
    });
    const harness = await startHarness({ wager });

    // When a legacy wallet read is requested
    const wallet = await fetch(
      `${harness.base}/api/groups/${CHAT_ID}/users/${USER_ID}/wallet`,
      { headers: authed },
    );

    // Then the starter beta exposes no wallet surface
    expect(wallet.status).toBe(404);
    expect(await wallet.json()).toEqual({ error: 'not_found' });
  });

  it('fails the readiness API when starter intake or budget is unavailable', async () => {
    // Given a matching starter runtime whose authoritative intake composite is off
    const { db, deps } = makeFakeDeps();
    const wager = createStarterOnlyWagerModule({
      runtimeMode: 'starter_only',
      db: starterOnlyWagerDbFromFake(db),
      log: deps.log,
      starterGrantsEnabled: true,
      stakeAcceptanceEnabled: true,
    });
    const ports = healthyReadinessPorts();
    const readiness = createReadinessEvaluator({
      checks: createEngineReadinessChecks(
        {
          ...ports,
          wager: {
            snapshot: async () => ({
              enabled: true,
              configured: true,
              runtimeMatches: true,
              paused: false,
              covered: true,
              starterIntakeReady: false,
            }),
          },
        },
        DEFAULT_ENGINE_READINESS_POLICY,
        () => READINESS_TEST_NOW,
      ),
      checkTimeoutMs: DEFAULT_ENGINE_READINESS_POLICY.checkTimeoutMs,
      deadline: { wait: async () => new Promise<void>(() => undefined) },
      drainState: new DrainState(),
    });
    const harness = await startHarness({ wager, readiness });

    // When deployment readiness is requested
    const response = await fetch(`${harness.base}/api/ready`);

    // Then promotion is blocked without exposing budget details
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: 'not_ready',
      reasons: ['starter_intake_unavailable'],
    });
  });
});
