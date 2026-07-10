import { ENGINE_READINESS_REASONS } from './api/readiness.js';
import type { Env } from './env.js';

export interface DisabledWagerBootState {
  readonly kind: 'disabled';
  readonly reason: typeof ENGINE_READINESS_REASONS.wagerDisabled;
}

export interface ConfiguredWagerBootState {
  readonly kind: 'configured';
}

export interface BlockedWagerBootState {
  readonly kind: 'blocked';
  readonly reason: typeof ENGINE_READINESS_REASONS.wagerUnavailable;
}

export type WagerBootState =
  | DisabledWagerBootState
  | ConfiguredWagerBootState
  | BlockedWagerBootState;

export class WagerBootError extends Error {
  readonly name = 'WagerBootError';

  constructor(readonly reason: typeof ENGINE_READINESS_REASONS.wagerUnavailable) {
    super(`engine_boot_blocked:${reason}`);
  }
}

function hasEnabledWagerCapability(env: Env): boolean {
  return (
    env.WAGER_MODE_ENABLED === 'true'
    || env.WALLET_MINIAPP_ENABLED
    || env.STAKE_ACCEPTANCE_ENABLED
    || env.STARTER_GRANTS_ENABLED
  );
}

export function evaluateWagerBootState(
  env: Env,
  wagerConfigured: boolean,
): WagerBootState {
  if (wagerConfigured) {
    return { kind: 'configured' };
  }
  if (!hasEnabledWagerCapability(env)) {
    return {
      kind: 'disabled',
      reason: ENGINE_READINESS_REASONS.wagerDisabled,
    };
  }
  return {
    kind: 'blocked',
    reason: ENGINE_READINESS_REASONS.wagerUnavailable,
  };
}

export function assertWagerBootable(env: Env, wagerConfigured: boolean): void {
  const state = evaluateWagerBootState(env, wagerConfigured);
  if (state.kind === 'blocked') {
    throw new WagerBootError(state.reason);
  }
}
