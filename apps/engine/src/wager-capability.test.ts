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
  it.each([
    {
      name: 'starter-only requested with a funded module',
      env: { ...DISABLED_ENV, WAGER_RUNTIME_MODE: 'starter_only' as const },
      constructedKind: 'funded' as const,
    },
    {
      name: 'disabled requested with a funded module',
      env: DISABLED_ENV,
      constructedKind: 'funded' as const,
    },
  ])('blocks boot when $name', ({ env, constructedKind }) => {
    // Given the requested capability differs from the constructed runtime
    // When the boot boundary compares both discriminants
    const state = evaluateWagerBootState(env, constructedKind);

    // Then startup fails closed
    expect(state).toEqual({ kind: 'blocked', reason: 'wager_unavailable' });
    expect(() => assertWagerBootable(env, constructedKind)).toThrowError(
      new WagerBootError('wager_unavailable'),
    );
  });

  it('allows a fully disabled engine to boot without wager wiring', () => {
    const state = evaluateWagerBootState(DISABLED_ENV, null);

    expect(state).toEqual({
      kind: 'disabled',
      reason: 'wager_disabled',
    });
    expect(() => assertWagerBootable(DISABLED_ENV, null)).not.toThrow();
  });

  it.each([
    {
      name: 'funded runtime is requested without a configured module',
      env: { ...DISABLED_ENV, WAGER_RUNTIME_MODE: 'funded' as const },
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
    const state = evaluateWagerBootState(env, null);

    expect(state).toEqual({
      kind: 'blocked',
      reason: 'wager_unavailable',
    });
    expect(() => assertWagerBootable(env, null)).toThrowError(
      new WagerBootError('wager_unavailable'),
    );
  });

  it('allows boot once the requested starter module is configured', () => {
    const starterEnv = { ...DISABLED_ENV, WAGER_RUNTIME_MODE: 'starter_only' as const };
    expect(evaluateWagerBootState(starterEnv, 'starter_only')).toEqual({
      kind: 'configured',
    });
    expect(() => assertWagerBootable(starterEnv, 'starter_only')).not.toThrow();
  });
});
