import { ENGINE_READINESS_REASONS } from './api/readiness.js';
import type { Env } from './env.js';
import type { WagerModule } from './wager/module.js';

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
    env.WAGER_RUNTIME_MODE !== 'disabled'
    || env.WALLET_MINIAPP_ENABLED
    || env.STAKE_ACCEPTANCE_ENABLED
    || env.STARTER_GRANTS_ENABLED
  );
}

export function evaluateWagerBootState(
  env: Env,
  constructedKind: WagerModule['kind'] | null,
): WagerBootState {
  if (
    env.WAGER_RUNTIME_MODE !== 'disabled'
    && constructedKind === env.WAGER_RUNTIME_MODE
  ) {
    return { kind: 'configured' };
  }
  if (constructedKind === null && !hasEnabledWagerCapability(env)) {
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

export function assertWagerBootable(
  env: Env,
  constructedKind: WagerModule['kind'] | null,
): void {
  const state = evaluateWagerBootState(env, constructedKind);
  if (state.kind === 'blocked') {
    throw new WagerBootError(state.reason);
  }
}
