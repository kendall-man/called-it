import { describe, expect, it } from 'vitest';
import { BASE_ENV } from './env.test-fixtures.js';
import { loadEnv } from './env.js';

const DEPLOYED_ENV = {
  ...BASE_ENV,
  DEPLOYMENT_ENV: 'staging',
  TELEGRAM_INGRESS: 'poll',
  BETA_ALLOWED_GROUP_IDS: '-100123',
  GLM_BASE_URL: 'https://api.z.ai/api/anthropic',
  SOLANA_RPC_URL: 'https://api.devnet.solana.com',
  WEB_BASE_URL: 'https://web.example.test',
  WALLET_LINK_DOMAIN: 'web.example.test',
} satisfies NodeJS.ProcessEnv;

const STARTER_ONLY_ENV = {
  ...DEPLOYED_ENV,
  WAGER_RUNTIME_MODE: 'starter_only',
  WAGER_MODE_ENABLED: 'true',
  STARTER_GRANTS_ENABLED: 'true',
  STAKE_ACCEPTANCE_ENABLED: 'true',
  WALLET_MINIAPP_ENABLED: 'false',
  TREASURY_COVERAGE_ENFORCED: 'false',
} satisfies NodeJS.ProcessEnv;

const MAINNET_ENV = {
  ...DEPLOYED_ENV,
  DEPLOYMENT_ENV: 'production',
  SOLANA_NETWORK: 'mainnet-beta',
  SOLANA_RPC_URL: 'https://mainnet-rpc.example.test',
  WAGER_RUNTIME_MODE: 'funded',
  WAGER_MODE_ENABLED: 'true',
  WAGER_TREASURY_KEYPAIR_B58: 'dedicated-mainnet-treasury',
  STARTER_GRANTS_ENABLED: 'false',
  STAKE_ACCEPTANCE_ENABLED: 'true',
  WALLET_MINIAPP_ENABLED: 'false',
  TREASURY_COVERAGE_ENFORCED: 'true',
} satisfies NodeJS.ProcessEnv;

describe('wager runtime environment', () => {
  it('accepts the explicit guarded mainnet funded profile', () => {
    expect(loadEnv(MAINNET_ENV)).toMatchObject({
      DEPLOYMENT_ENV: 'production',
      SOLANA_NETWORK: 'mainnet-beta',
      WAGER_RUNTIME_MODE: 'funded',
      STARTER_GRANTS_ENABLED: false,
      STAKE_ACCEPTANCE_ENABLED: true,
      WALLET_MINIAPP_ENABLED: false,
      TREASURY_COVERAGE_ENFORCED: true,
    });
  });

  it('accepts signed webhook ingress for the guarded mainnet funded profile', () => {
    expect(loadEnv({
      ...MAINNET_ENV,
      TELEGRAM_INGRESS: 'webhook',
      TELEGRAM_WEBHOOK_SECRET_TOKEN: 'mainnet-telegram-webhook-secret-token',
    })).toMatchObject({
      SOLANA_NETWORK: 'mainnet-beta',
      WAGER_RUNTIME_MODE: 'funded',
      TELEGRAM_INGRESS: 'webhook',
    });
  });

  it.each([
    ['a devnet RPC', { SOLANA_RPC_URL: 'https://api.devnet.solana.com' }, 'SOLANA_RPC_URL'],
    [
      'starter-only mode',
      { WAGER_RUNTIME_MODE: 'starter_only' },
      'SOLANA_NETWORK, STARTER_GRANTS_ENABLED, TREASURY_COVERAGE_ENFORCED, WAGER_RUNTIME_MODE, WAGER_TREASURY_KEYPAIR_B58',
    ],
    ['starter grants', { STARTER_GRANTS_ENABLED: 'true' }, 'SOLANA_NETWORK, STARTER_GRANTS_ENABLED'],
    ['disabled stake intake', { STAKE_ACCEPTANCE_ENABLED: 'false' }, 'SOLANA_NETWORK, STAKE_ACCEPTANCE_ENABLED'],
    ['disabled coverage breaker', { TREASURY_COVERAGE_ENFORCED: 'false' }, 'SOLANA_NETWORK, TREASURY_COVERAGE_ENFORCED'],
  ] as const)('rejects mainnet with %s', (_name, overrides, variables) => {
    expect(() => loadEnv({ ...MAINNET_ENV, ...overrides })).toThrowError(
      `Engine environment invalid: ${variables}`,
    );
  });

  it('derives the development runtime from the legacy compatibility flag', () => {
    // Given local environments that predate the explicit runtime selector
    const disabled = { ...BASE_ENV };
    const funded = { ...BASE_ENV, WAGER_MODE_ENABLED: 'true' };

    // When both environments are parsed
    const disabledRuntime = loadEnv(disabled);
    const fundedRuntime = loadEnv(funded);

    // Then compatibility remains local and deterministic
    expect(disabledRuntime.WAGER_RUNTIME_MODE).toBe('disabled');
    expect(fundedRuntime.WAGER_RUNTIME_MODE).toBe('funded');
  });

  it.each(['staging', 'production'] as const)(
    'requires an explicit runtime selector in %s',
    (deploymentEnvironment) => {
      // Given a deployable environment with only the legacy switch
      const source = {
        ...DEPLOYED_ENV,
        DEPLOYMENT_ENV: deploymentEnvironment,
        WAGER_MODE_ENABLED: 'false',
      };

      // When the engine parses its environment
      const parse = () => loadEnv(source);

      // Then deployment stops on the missing capability selector
      expect(parse).toThrowError('Engine environment invalid: WAGER_RUNTIME_MODE');
    },
  );

  it.each(['staging', 'production'] as const)(
    'rejects an enabled legacy switch with explicit disabled mode in %s',
    (deploymentEnvironment) => {
      // Given a deployed runtime whose coarse legacy switch contradicts the selector
      const source = {
        ...DEPLOYED_ENV,
        DEPLOYMENT_ENV: deploymentEnvironment,
        WAGER_RUNTIME_MODE: 'disabled',
        WAGER_MODE_ENABLED: 'true',
      };

      // When the engine parses its environment
      const parse = () => loadEnv(source);

      // Then startup names both contradictory variables
      expect(parse).toThrowError(
        'Engine environment invalid: WAGER_MODE_ENABLED, WAGER_RUNTIME_MODE',
      );
    },
  );

  it.each(['staging', 'production'] as const)(
    'rejects a disabled legacy switch with explicit starter-only mode in %s',
    (deploymentEnvironment) => {
      // Given a deployed starter runtime contradicted by the coarse legacy switch
      const source = {
        ...STARTER_ONLY_ENV,
        DEPLOYMENT_ENV: deploymentEnvironment,
        WAGER_MODE_ENABLED: 'false',
      };

      // When the engine parses its environment
      const parse = () => loadEnv(source);

      // Then startup names both contradictory variables
      expect(parse).toThrowError(
        'Engine environment invalid: WAGER_MODE_ENABLED, WAGER_RUNTIME_MODE',
      );
    },
  );

  it('accepts starter-only intake without funded custody configuration', () => {
    // Given the direct allowlisted beta with starter intake and no treasury
    const source = {
      ...STARTER_ONLY_ENV,
      WAGER_TREASURY_KEYPAIR_B58: '',
      WAGER_OPS_CHAT_ID: '',
    };

    // When the engine parses its environment
    const parsed = loadEnv(source);

    // Then the explicit DB-only capability is preserved without legacy elevation
    expect(parsed).toMatchObject({
      WAGER_RUNTIME_MODE: 'starter_only',
      STARTER_GRANTS_ENABLED: true,
      STAKE_ACCEPTANCE_ENABLED: true,
      WALLET_MINIAPP_ENABLED: false,
      TREASURY_COVERAGE_ENFORCED: false,
    });
    expect(parsed.WAGER_TREASURY_KEYPAIR_B58).toBeUndefined();
  });

  it.each([
    {
      name: 'webhook ingress',
      overrides: {
        DEPLOYMENT_ENV: 'development',
        TELEGRAM_INGRESS: 'webhook',
        TELEGRAM_WEBHOOK_SECRET_TOKEN: 'starter-webhook-secret-token-value',
      },
      variables: 'TELEGRAM_INGRESS',
    },
    {
      name: 'an empty group allowlist',
      overrides: { DEPLOYMENT_ENV: 'development', BETA_ALLOWED_GROUP_IDS: '' },
      variables: 'BETA_ALLOWED_GROUP_IDS',
    },
    {
      name: 'wallet Mini App exposure',
      overrides: { WALLET_MINIAPP_ENABLED: 'true' },
      variables: 'WALLET_MINIAPP_ENABLED',
    },
    {
      name: 'disabled starter intake',
      overrides: { STARTER_GRANTS_ENABLED: 'false', STAKE_ACCEPTANCE_ENABLED: 'false' },
      variables: 'STAKE_ACCEPTANCE_ENABLED, STARTER_GRANTS_ENABLED',
    },
    {
      name: 'a wager treasury signer',
      overrides: { WAGER_TREASURY_KEYPAIR_B58: 'funded-custody-secret' },
      variables: 'WAGER_TREASURY_KEYPAIR_B58',
    },
    {
      name: 'treasury coverage enforcement',
      overrides: { TREASURY_COVERAGE_ENFORCED: 'true' },
      variables: 'TREASURY_COVERAGE_ENFORCED',
    },
  ])('rejects starter-only with $name', ({ overrides, variables }) => {
    // Given a starter-only runtime with a contradictory capability
    const source = { ...STARTER_ONLY_ENV, ...overrides };

    // When the engine parses its environment
    const parse = () => loadEnv(source);

    // Then startup names the exact unsafe setting
    expect(parse).toThrowError(`Engine environment invalid: ${variables}`);
  });

  it('rejects active stake intake when the explicit runtime is disabled', () => {
    // Given custody details remain configured but the capability selector is off
    const source = {
      ...BASE_ENV,
      WAGER_RUNTIME_MODE: 'disabled',
      WAGER_TREASURY_KEYPAIR_B58: 'dormant-funded-treasury',
      STAKE_ACCEPTANCE_ENABLED: 'true',
      TREASURY_COVERAGE_ENFORCED: 'true',
    };

    // When the engine parses its environment
    const parse = () => loadEnv(source);

    // Then active intake and the disabled selector are named as contradictory
    expect(parse).toThrowError(
      'Engine environment invalid: STAKE_ACCEPTANCE_ENABLED, WAGER_RUNTIME_MODE',
    );
  });

  it('rejects starter grants in the deferred funded runtime', () => {
    // Given funded custody is otherwise complete but starter grants are also enabled
    const source = {
      ...BASE_ENV,
      WAGER_RUNTIME_MODE: 'funded',
      WAGER_MODE_ENABLED: 'true',
      WAGER_TREASURY_KEYPAIR_B58: 'dedicated-funded-treasury',
      STARTER_GRANTS_ENABLED: 'true',
      STAKE_ACCEPTANCE_ENABLED: 'true',
      TREASURY_COVERAGE_ENFORCED: 'true',
    };

    // When the engine parses its environment
    const parse = () => loadEnv(source);

    // Then startup rejects the capability instead of dropping it at construction
    expect(parse).toThrowError('Engine environment invalid: STARTER_GRANTS_ENABLED');
  });

  it.each([
    {
      mode: 'disabled',
      source: {
        ...BASE_ENV,
        WAGER_RUNTIME_MODE: 'disabled',
        WAGER_MODE_ENABLED: 'true',
      },
    },
    {
      mode: 'starter_only',
      source: {
        ...STARTER_ONLY_ENV,
        DEPLOYMENT_ENV: 'development',
        WAGER_MODE_ENABLED: 'false',
      },
    },
    {
      mode: 'funded',
      source: {
        ...BASE_ENV,
        WAGER_RUNTIME_MODE: 'funded',
        WAGER_MODE_ENABLED: 'false',
        WAGER_TREASURY_KEYPAIR_B58: 'dedicated-funded-treasury',
        STARTER_GRANTS_ENABLED: 'false',
        STAKE_ACCEPTANCE_ENABLED: 'true',
        TREASURY_COVERAGE_ENFORCED: 'true',
      },
    },
  ] as const)('treats explicit $mode as authoritative over the legacy flag in development', ({ mode, source }) => {
    // Given one of the three explicit local runtime modes
    // When the environment is parsed
    const parsed = loadEnv(source);

    // Then development preserves selector precedence for local compatibility
    expect(parsed.WAGER_RUNTIME_MODE).toBe(mode);
  });
});
