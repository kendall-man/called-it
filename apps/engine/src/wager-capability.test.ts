import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';
import { BASE_ENV } from './env.test-fixtures.js';
import {
  WagerBootError,
  assertWagerBootable,
  evaluateWagerBootState,
} from './wager-capability.js';

const DISABLED_ENV = loadEnv(BASE_ENV);

describe('wager boot capability', () => {
  it('allows a fully disabled engine to boot without wager wiring', () => {
    const state = evaluateWagerBootState(DISABLED_ENV, false);

    expect(state).toEqual({
      kind: 'disabled',
      reason: 'wager_disabled',
    });
    expect(() => assertWagerBootable(DISABLED_ENV, false)).not.toThrow();
  });

  it.each([
    {
      name: 'wager mode is enabled without a configured module',
      env: { ...DISABLED_ENV, WAGER_MODE_ENABLED: 'true' as const },
    },
    {
      name: 'wallet miniapp exposure is enabled without a configured module',
      env: { ...DISABLED_ENV, WALLET_MINIAPP_ENABLED: true },
    },
    {
      name: 'stake acceptance is enabled without a configured module',
      env: { ...DISABLED_ENV, STAKE_ACCEPTANCE_ENABLED: true },
    },
    {
      name: 'starter grants are enabled without a configured module',
      env: { ...DISABLED_ENV, STARTER_GRANTS_ENABLED: true },
    },
  ])('blocks boot when $name', ({ env }) => {
    const state = evaluateWagerBootState(env, false);

    expect(state).toEqual({
      kind: 'blocked',
      reason: 'wager_unavailable',
    });
    expect(() => assertWagerBootable(env, false)).toThrowError(
      new WagerBootError('wager_unavailable'),
    );
  });

  it('allows boot once the wager module is configured', () => {
    expect(evaluateWagerBootState(DISABLED_ENV, true)).toEqual({
      kind: 'configured',
    });
    expect(() => assertWagerBootable(DISABLED_ENV, true)).not.toThrow();
  });
});
