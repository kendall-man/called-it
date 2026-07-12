export const WAGER_RUNTIME_MODES = ['disabled', 'starter_only', 'funded'] as const;
export type WagerRuntimeMode = (typeof WAGER_RUNTIME_MODES)[number];

export interface WagerRuntimeEnvironmentInput {
  readonly DEPLOYMENT_ENV: 'development' | 'staging' | 'production';
  readonly WAGER_RUNTIME_MODE?: WagerRuntimeMode;
  readonly WAGER_MODE_ENABLED: 'true' | 'false';
  readonly TELEGRAM_INGRESS: 'poll' | 'webhook';
  readonly BETA_ALLOWED_GROUP_IDS: readonly number[];
  readonly STARTER_GRANTS_ENABLED: boolean;
  readonly STAKE_ACCEPTANCE_ENABLED: boolean;
  readonly WALLET_MINIAPP_ENABLED: boolean;
  readonly WAGER_TREASURY_KEYPAIR_B58?: string;
  readonly TREASURY_COVERAGE_ENFORCED: boolean;
}

export interface WagerRuntimeEnvironmentIssues {
  add(variable: string, message: string): void;
  addPair(left: string, right: string): void;
}

export function resolvedWagerRuntimeMode(
  env: Pick<WagerRuntimeEnvironmentInput, 'WAGER_RUNTIME_MODE' | 'WAGER_MODE_ENABLED'>,
): WagerRuntimeMode {
  return env.WAGER_RUNTIME_MODE
    ?? (env.WAGER_MODE_ENABLED === 'true' ? 'funded' : 'disabled');
}

export function validateWagerRuntimeEnvironment(
  env: WagerRuntimeEnvironmentInput,
  issues: WagerRuntimeEnvironmentIssues,
): void {
  const mode = resolvedWagerRuntimeMode(env);
  if (env.DEPLOYMENT_ENV !== 'development' && env.WAGER_RUNTIME_MODE === undefined) {
    issues.add('WAGER_RUNTIME_MODE', 'required in deployed environments');
  }
  if (
    env.DEPLOYMENT_ENV !== 'development'
    && env.WAGER_RUNTIME_MODE !== undefined
    && (env.WAGER_RUNTIME_MODE !== 'disabled') !== (env.WAGER_MODE_ENABLED === 'true')
  ) {
    issues.addPair('WAGER_MODE_ENABLED', 'WAGER_RUNTIME_MODE');
  }

  switch (mode) {
    case 'disabled': {
      const activeCapabilities = [
        ['STARTER_GRANTS_ENABLED', env.STARTER_GRANTS_ENABLED],
        ['STAKE_ACCEPTANCE_ENABLED', env.STAKE_ACCEPTANCE_ENABLED],
        ['WALLET_MINIAPP_ENABLED', env.WALLET_MINIAPP_ENABLED],
      ] as const;
      for (const [variable, enabled] of activeCapabilities) {
        if (enabled) issues.addPair(variable, 'WAGER_RUNTIME_MODE');
      }
      return;
    }
    case 'starter_only':
      if (env.TELEGRAM_INGRESS !== 'poll') {
        issues.add('TELEGRAM_INGRESS', 'starter-only requires direct polling ingress');
      }
      if (env.BETA_ALLOWED_GROUP_IDS.length === 0) {
        issues.add('BETA_ALLOWED_GROUP_IDS', 'starter-only requires an allowlisted group');
      }
      if (env.WALLET_MINIAPP_ENABLED) {
        issues.add('WALLET_MINIAPP_ENABLED', 'starter-only forbids wallet exposure');
      }
      if (!env.STARTER_GRANTS_ENABLED) {
        issues.add('STARTER_GRANTS_ENABLED', 'starter-only requires starter grants');
      }
      if (!env.STAKE_ACCEPTANCE_ENABLED) {
        issues.add('STAKE_ACCEPTANCE_ENABLED', 'starter-only requires starter intake');
      }
      if (env.WAGER_TREASURY_KEYPAIR_B58 !== undefined) {
        issues.add('WAGER_TREASURY_KEYPAIR_B58', 'starter-only forbids a wager treasury signer');
      }
      if (env.TREASURY_COVERAGE_ENFORCED) {
        issues.add('TREASURY_COVERAGE_ENFORCED', 'starter-only has no wager treasury custody');
      }
      return;
    case 'funded':
      if (env.STARTER_GRANTS_ENABLED) {
        issues.add('STARTER_GRANTS_ENABLED', 'funded runtime does not support starter grants');
      }
      return;
    default:
      return assertNeverMode(mode);
  }
}

function assertNeverMode(mode: never): never {
  throw new TypeError(`unsupported wager runtime mode: ${String(mode)}`);
}
