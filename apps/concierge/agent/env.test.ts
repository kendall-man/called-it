import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConciergeEnv } from './env.js';
import {
  BASE_ENV,
  CURRENT_MASTER,
  NOW_EPOCH_MS,
  PREVIOUS_MASTER,
} from './env.test-fixtures.js';
import { accountSessionKeyringMetadata } from './session-keys.js';

describe('concierge runtime environment', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('fails startup when the private engine URL is missing', async () => {
    // Given the runtime has a model key but no private engine endpoint
    vi.stubEnv('GLM_API_KEY', 'glm-test-key');
    vi.stubEnv('ENGINE_PRIVATE_API_URL', '');

    // When the Eve agent module starts
    const start = () => import('./agent.js');

    // Then startup fails closed with the missing variable name
    await expect(start()).rejects.toThrowError(/ENGINE_PRIVATE_API_URL/);
  });

  it('derives distinct JWE and CSRF subkeys from a current session master', () => {
    // Given a canonical 32-byte master and current key identifier
    const source = {
      ...BASE_ENV,
      WALLET_MINIAPP_ENABLED: 'true',
      ACCOUNT_SESSION_KEY_CURRENT: CURRENT_MASTER,
      ACCOUNT_SESSION_KEY_CURRENT_KID: 'session-2026-07-10',
    };

    // When the concierge parses its environment
    const parsed = loadConciergeEnv(source);

    // Then only distinct derived keys are returned for runtime use
    const current = parsed.ACCOUNT_SESSION_KEYRING?.current;
    expect(current?.kid).toBe('session-2026-07-10');
    expect(current?.jweKey).toHaveLength(32);
    expect(current?.csrfKey).toHaveLength(32);
    expect(current?.jweKey).not.toEqual(current?.csrfKey);
    expect(parsed).not.toHaveProperty('ACCOUNT_SESSION_KEY_CURRENT');
  });

  it('parses an explicitly disabled runtime without session key material', () => {
    // Given all user-facing capabilities are explicitly disabled
    const source = { ...BASE_ENV };

    // When the concierge parses its environment
    const parsed = loadConciergeEnv(source, NOW_EPOCH_MS);

    // Then switches and readiness thresholds are typed and no keyring exists
    expect(parsed).toMatchObject({
      STARTER_GRANTS_ENABLED: false,
      WALLET_MINIAPP_ENABLED: false,
      STAKE_ACCEPTANCE_ENABLED: false,
      READINESS_ENGINE_TIMEOUT_MS: 3_000,
      READINESS_CHECK_TIMEOUT_MS: 5_000,
      SHUTDOWN_DRAIN_TIMEOUT_MS: 12_000,
      ACCOUNT_SESSION_KEYRING: null,
    });
  });

  it.each([
    {
      name: 'a malformed rollout switch',
      source: { ...BASE_ENV, WALLET_MINIAPP_ENABLED: 'enabled' },
      variables: 'WALLET_MINIAPP_ENABLED',
    },
    {
      name: 'starter grants while stake acceptance is disabled',
      source: { ...BASE_ENV, STARTER_GRANTS_ENABLED: 'true' },
      variables: 'STAKE_ACCEPTANCE_ENABLED, STARTER_GRANTS_ENABLED',
    },
    {
      name: 'duplicate route credentials',
      source: {
        ...BASE_ENV,
        WEB_CONCIERGE_TOKEN: BASE_ENV.ENGINE_CONCIERGE_TOKEN,
      },
      variables: 'ENGINE_CONCIERGE_TOKEN, WEB_CONCIERGE_TOKEN',
    },
    {
      name: 'plain HTTP for the production web origin',
      source: { ...BASE_ENV, DEPLOYMENT_ENV: 'production' },
      variables: 'WEB_BASE_URL',
    },
    {
      name: 'a public engine URL in a deployed environment',
      source: {
        ...BASE_ENV,
        DEPLOYMENT_ENV: 'production',
        ENGINE_PRIVATE_API_URL: 'https://engine.example.test',
        WEB_BASE_URL: 'https://web.example.test',
        WALLET_LINK_DOMAIN: 'web.example.test',
      },
      variables: 'ENGINE_PRIVATE_API_URL',
    },
    {
      name: 'a wallet domain that differs from the web origin',
      source: { ...BASE_ENV, WALLET_LINK_DOMAIN: 'wallet.example.test' },
      variables: 'WALLET_LINK_DOMAIN, WEB_BASE_URL',
    },
    {
      name: 'an engine check that exhausts the readiness budget',
      source: { ...BASE_ENV, READINESS_ENGINE_TIMEOUT_MS: '5000' },
      variables: 'READINESS_CHECK_TIMEOUT_MS, READINESS_ENGINE_TIMEOUT_MS',
    },
  ])('rejects $name without echoing values', ({ source, variables }) => {
    // Given a malformed, contradictory, or unsafe runtime configuration
    const parse = () => loadConciergeEnv(source, NOW_EPOCH_MS);

    // When the concierge parses its environment
    const invoke = parse;

    // Then startup returns the deterministic variable-name-only contract
    expect(invoke).toThrowError(`Concierge environment invalid: ${variables}`);
  });

  it('accepts a previous key only for the bounded overlap and exposes redacted metadata', () => {
    // Given a complete current and previous keyring expiring in ten minutes
    const expiresAt = new Date(NOW_EPOCH_MS + 10 * 60 * 1_000).toISOString();
    const source = {
      ...BASE_ENV,
      WALLET_MINIAPP_ENABLED: 'true',
      ACCOUNT_SESSION_KEY_CURRENT: CURRENT_MASTER,
      ACCOUNT_SESSION_KEY_CURRENT_KID: 'session-current',
      ACCOUNT_SESSION_KEY_PREVIOUS: PREVIOUS_MASTER,
      ACCOUNT_SESSION_KEY_PREVIOUS_KID: 'session-previous',
      ACCOUNT_SESSION_KEY_PREVIOUS_EXPIRES_AT: expiresAt,
    };

    // When the concierge parses the rotation configuration
    const parsed = loadConciergeEnv(source, NOW_EPOCH_MS);

    // Then metadata identifies usage and expiry without serializing any key bytes
    const keyring = parsed.ACCOUNT_SESSION_KEYRING;
    expect(keyring).not.toBeNull();
    if (keyring === null) return;
    const metadata = accountSessionKeyringMetadata(keyring);
    expect(metadata).toEqual({
      current: { kid: 'session-current', encrypts: true, accepts: true },
      previous: {
        kid: 'session-previous',
        encrypts: false,
        acceptUntil: expiresAt,
      },
    });
    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain(CURRENT_MASTER);
    expect(serialized).not.toContain(PREVIOUS_MASTER);
    expect(serialized).not.toContain('jweKey');
    expect(serialized).not.toContain('csrfKey');
  });

  it.each([
    {
      name: 'a 31-byte current master',
      source: {
        ...BASE_ENV,
        WALLET_MINIAPP_ENABLED: 'true',
        ACCOUNT_SESSION_KEY_CURRENT: Buffer.alloc(31, 1).toString('base64'),
        ACCOUNT_SESSION_KEY_CURRENT_KID: 'session-current',
      },
      variables: 'ACCOUNT_SESSION_KEY_CURRENT',
    },
    {
      name: 'an incomplete previous key tuple',
      source: {
        ...BASE_ENV,
        ACCOUNT_SESSION_KEY_CURRENT: CURRENT_MASTER,
        ACCOUNT_SESSION_KEY_CURRENT_KID: 'session-current',
        ACCOUNT_SESSION_KEY_PREVIOUS: PREVIOUS_MASTER,
      },
      variables: 'ACCOUNT_SESSION_KEY_PREVIOUS_EXPIRES_AT, ACCOUNT_SESSION_KEY_PREVIOUS_KID',
    },
    {
      name: 'duplicate current and previous material',
      source: {
        ...BASE_ENV,
        ACCOUNT_SESSION_KEY_CURRENT: CURRENT_MASTER,
        ACCOUNT_SESSION_KEY_CURRENT_KID: 'session-same',
        ACCOUNT_SESSION_KEY_PREVIOUS: CURRENT_MASTER,
        ACCOUNT_SESSION_KEY_PREVIOUS_KID: 'session-same',
        ACCOUNT_SESSION_KEY_PREVIOUS_EXPIRES_AT: new Date(
          NOW_EPOCH_MS + 10 * 60 * 1_000,
        ).toISOString(),
      },
      variables: [
        'ACCOUNT_SESSION_KEY_CURRENT',
        'ACCOUNT_SESSION_KEY_CURRENT_KID',
        'ACCOUNT_SESSION_KEY_PREVIOUS',
        'ACCOUNT_SESSION_KEY_PREVIOUS_KID',
      ].join(', '),
    },
  ])('rejects $name', ({ source, variables }) => {
    // Given malformed or incomplete rotation material
    const parse = () => loadConciergeEnv(source, NOW_EPOCH_MS);

    // When the concierge parses its environment
    const invoke = parse;

    // Then startup reports only the responsible key metadata variables
    expect(invoke).toThrowError(`Concierge environment invalid: ${variables}`);
  });

  it.each([
    NOW_EPOCH_MS,
    NOW_EPOCH_MS + 10 * 60 * 1_000 + 1,
  ])('rejects previous-key expiry outside the ten-minute overlap at %s', (expiresAt) => {
    // Given a previous key whose acceptance deadline is expired or too distant
    const source = {
      ...BASE_ENV,
      ACCOUNT_SESSION_KEY_CURRENT: CURRENT_MASTER,
      ACCOUNT_SESSION_KEY_CURRENT_KID: 'session-current',
      ACCOUNT_SESSION_KEY_PREVIOUS: PREVIOUS_MASTER,
      ACCOUNT_SESSION_KEY_PREVIOUS_KID: 'session-previous',
      ACCOUNT_SESSION_KEY_PREVIOUS_EXPIRES_AT: new Date(expiresAt).toISOString(),
    };

    // When the concierge parses its environment
    const parse = () => loadConciergeEnv(source, NOW_EPOCH_MS);

    // Then startup fails on the overlap metadata only
    expect(parse).toThrowError(
      'Concierge environment invalid: ACCOUNT_SESSION_KEY_PREVIOUS_EXPIRES_AT',
    );
  });
});
