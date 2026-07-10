import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';
import { BASE_ENV } from './env.test-fixtures.js';

describe('engine rollout environment', () => {
  it.each([
    {
      source: { ...BASE_ENV, QUEUE_RETRY_BASE_MS: '31000' },
      variables: 'QUEUE_RETRY_BASE_MS, QUEUE_RETRY_MAX_MS',
    },
    {
      source: { ...BASE_ENV, QUEUE_LEASE_MS: '4000' },
      variables: 'QUEUE_LEASE_MS, READINESS_CHECK_TIMEOUT_MS',
    },
    {
      source: { ...BASE_ENV, SHUTDOWN_DRAIN_TIMEOUT_MS: '4000' },
      variables: 'READINESS_CHECK_TIMEOUT_MS, SHUTDOWN_DRAIN_TIMEOUT_MS',
    },
  ])('rejects contradictory queue timing for $variables', ({ source, variables }) => {
    // Given queue timing that cannot satisfy retry, readiness, or drain ordering
    const parse = () => loadEnv(source);

    // When the engine parses its environment
    const invoke = parse;

    // Then startup identifies both sides of the invalid ordering
    expect(invoke).toThrowError(`Engine environment invalid: ${variables}`);
  });

  it('rejects duplicate route credentials without disclosing the credential', () => {
    // Given two route scopes configured with the same sentinel credential
    const duplicate = 'do-not-disclose-this-duplicate-route-token';
    const source = {
      ...BASE_ENV,
      ENGINE_CONCIERGE_TOKEN: duplicate,
      ENGINE_TELEGRAM_TOKEN: duplicate,
    };

    // When the engine parses its environment
    const parse = () => loadEnv(source);

    // Then startup names both variables and never includes the secret value
    expect(parse).toThrowError(
      /^Engine environment invalid: ENGINE_CONCIERGE_TOKEN, ENGINE_TELEGRAM_TOKEN$/,
    );
    try {
      parse();
    } catch (error) {
      if (error instanceof Error) {
        expect(error.message).not.toContain(duplicate);
        return;
      }
      throw error;
    }
    throw new Error('expected duplicate route credentials to fail');
  });

  it.each([
    {
      name: 'starter grants without stake acceptance',
      source: {
        ...BASE_ENV,
        STARTER_GRANTS_ENABLED: 'true',
      },
      variables: 'STAKE_ACCEPTANCE_ENABLED, STARTER_GRANTS_ENABLED',
    },
    {
      name: 'stake acceptance without a treasury or enforced coverage',
      source: {
        ...BASE_ENV,
        WAGER_MODE_ENABLED: 'true',
        STAKE_ACCEPTANCE_ENABLED: 'true',
      },
      variables: 'TREASURY_COVERAGE_ENFORCED, WAGER_TREASURY_KEYPAIR_B58',
    },
    {
      name: 'stake acceptance while the wager module is disabled',
      source: {
        ...BASE_ENV,
        STAKE_ACCEPTANCE_ENABLED: 'true',
        TREASURY_COVERAGE_ENFORCED: 'true',
        WAGER_TREASURY_KEYPAIR_B58: 'dedicated-treasury-keypair',
      },
      variables: 'STAKE_ACCEPTANCE_ENABLED, WAGER_MODE_ENABLED',
    },
  ])('rejects $name', ({ source, variables }) => {
    // Given a rollout configuration with an unsafe capability dependency
    const parse = () => loadEnv(source);

    // When the engine parses its environment
    const invoke = parse;

    // Then startup fails with only the responsible variable names
    expect(invoke).toThrowError(`Engine environment invalid: ${variables}`);
  });
});
