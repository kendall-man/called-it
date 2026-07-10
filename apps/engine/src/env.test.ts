import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { loadEnv } from './env.js';
import { BASE_ENV } from './env.test-fixtures.js';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('loadEnv', () => {
  it('preserves the existing valid defaults when optional settings are absent', () => {
    // Given a complete baseline environment without optional overrides
    const source = { ...BASE_ENV };

    // When the engine parses its environment
    const parsed = loadEnv(source);

    // Then the established runtime defaults remain stable
    expect(parsed).toMatchObject({
      GLM_BASE_URL: 'https://api.z.ai/api/anthropic',
      SOLANA_RPC_URL: 'https://api.devnet.solana.com',
      PORT: 8790,
      TELEGRAM_INGRESS: 'poll',
      WAGER_MODE_ENABLED: 'false',
    });
  });

  it('rejects reuse of the proof wallet as the wager treasury', () => {
    // Given one secret configured for both wallet roles
    const source = {
      ...BASE_ENV,
      SOLANA_KEYPAIR_B58: 'same-wallet-secret',
      WAGER_TREASURY_KEYPAIR_B58: 'same-wallet-secret',
    };

    // When the engine parses its environment
    const parse = () => loadEnv(source);

    // Then the existing dedicated-treasury boundary remains fail-closed
    expect(parse).toThrowError(/WAGER_TREASURY_KEYPAIR_B58/);
  });

  it('rejects a malformed rollout switch instead of treating it as disabled', () => {
    // Given a switch value outside the explicit true/false contract
    const source = { ...BASE_ENV, STARTER_GRANTS_ENABLED: 'yes' };

    // When the engine parses its environment
    const parse = () => loadEnv(source);

    // Then startup fails and names only the invalid variable
    expect(parse).toThrowError(/^Engine environment invalid: STARTER_GRANTS_ENABLED$/);
  });

  it('parses a complete disabled configuration into typed rollout and readiness values', () => {
    // Given every capability is explicitly disabled with bounded queue settings
    const source = { ...BASE_ENV };

    // When the engine parses its environment
    const parsed = loadEnv(source);

    // Then callers receive booleans and numeric thresholds instead of raw strings
    expect(parsed).toMatchObject({
      DEPLOYMENT_ENV: 'development',
      STARTER_GRANTS_ENABLED: false,
      WALLET_MINIAPP_ENABLED: false,
      STAKE_ACCEPTANCE_ENABLED: false,
      TREASURY_COVERAGE_ENFORCED: false,
      QUEUE_LEASE_MS: 30_000,
      QUEUE_MAX_ATTEMPTS: 8,
      READINESS_CHECK_TIMEOUT_MS: 5_000,
      READINESS_WORKER_MAX_AGE_MS: 30_000,
      READINESS_PROOF_MAX_BACKLOG: 100,
      READINESS_PROOF_MAX_OLDEST_AGE_MS: 600_000,
      READINESS_SETTLEMENT_MAX_BACKLOG: 100,
      READINESS_SETTLEMENT_MAX_OLDEST_AGE_MS: 120_000,
      SHUTDOWN_DRAIN_TIMEOUT_MS: 12_000,
    });
  });

  it('accepts a complete production configuration with all capabilities enabled safely', () => {
    // Given webhook transport, an isolated treasury, and enforced coverage
    const source = {
      ...BASE_ENV,
      DEPLOYMENT_ENV: 'production',
      TELEGRAM_INGRESS: 'webhook',
      TELEGRAM_WEBHOOK_SECRET_TOKEN: 'webhook-secret-token-with-32-bytes',
      WEB_CONCIERGE_TOKEN_SHA256: sha256('web-concierge-token-with-32-bytes-'),
      GLM_BASE_URL: 'https://api.z.ai/api/anthropic',
      SOLANA_RPC_URL: 'https://api.devnet.solana.com',
      WEB_BASE_URL: 'https://web.example.test',
      WALLET_LINK_DOMAIN: 'web.example.test',
      WAGER_MODE_ENABLED: 'true',
      WAGER_TREASURY_KEYPAIR_B58: 'dedicated-treasury-keypair',
      TREASURY_COVERAGE_ENFORCED: 'true',
      STAKE_ACCEPTANCE_ENABLED: 'true',
      STARTER_GRANTS_ENABLED: 'true',
      WALLET_MINIAPP_ENABLED: 'true',
    };

    // When the engine parses its environment
    const parsed = loadEnv(source);

    // Then each independent switch is enabled as a typed value
    expect(parsed).toMatchObject({
      STARTER_GRANTS_ENABLED: true,
      WALLET_MINIAPP_ENABLED: true,
      STAKE_ACCEPTANCE_ENABLED: true,
      TREASURY_COVERAGE_ENFORCED: true,
    });
  });

  it('rejects omitted provider URLs in production instead of applying local defaults', () => {
    // Given an otherwise valid production environment without explicit providers
    const source = {
      ...BASE_ENV,
      DEPLOYMENT_ENV: 'production',
      TELEGRAM_INGRESS: 'webhook',
      TELEGRAM_WEBHOOK_SECRET_TOKEN: 'webhook-secret-token-with-32-bytes',
      WEB_CONCIERGE_TOKEN_SHA256: sha256('web-concierge-token-with-32-bytes-'),
      WEB_BASE_URL: 'https://web.example.test',
      WALLET_LINK_DOMAIN: 'web.example.test',
    };

    // When the engine parses its environment
    const parse = () => loadEnv(source);

    // Then startup requires both production provider variables explicitly
    expect(parse).toThrowError(
      'Engine environment invalid: GLM_BASE_URL, SOLANA_RPC_URL',
    );
  });

  it('rejects a missing route credential', () => {
    // Given the operations route has no credential
    const { ENGINE_OPS_TOKEN: _omitted, ...source } = BASE_ENV;

    // When the engine parses its environment
    const parse = () => loadEnv(source);

    // Then startup names the missing variable
    expect(parse).toThrowError('Engine environment invalid: ENGINE_OPS_TOKEN');
  });

  it.each([
    ['ENGINE_CONCIERGE_TOKEN', BASE_ENV.ENGINE_CONCIERGE_TOKEN],
    ['ENGINE_TELEGRAM_TOKEN', BASE_ENV.ENGINE_TELEGRAM_TOKEN],
    ['ENGINE_OPS_TOKEN', BASE_ENV.ENGINE_OPS_TOKEN],
  ])('rejects WEB_CONCIERGE_TOKEN fingerprint reuse of %s without echoing values', (routeName, token) => {
    // Given the web bridge credential fingerprint duplicates an engine route credential
    const source = { ...BASE_ENV, WEB_CONCIERGE_TOKEN_SHA256: sha256(token) };

    // When the engine parser audits the shared deployment environment
    const parse = () => loadEnv(source);

    // Then startup names both variables without reflecting credential material
    const variables = [routeName, 'WEB_CONCIERGE_TOKEN'].sort().join(', ');
    expect(parse).toThrowError(`Engine environment invalid: ${variables}`);
  });

  it('strips the audit-only web credential fingerprint from engine runtime config', () => {
    // Given a distinct web bridge credential fingerprint is visible in a shared environment
    const source = {
      ...BASE_ENV,
      WEB_CONCIERGE_TOKEN_SHA256: sha256('distinct-web-bridge-token-with-32-bytes'),
    };

    // When the engine parser audits and returns runtime config
    const parsed = loadEnv(source);

    // Then engine code cannot consume the web credential
    expect(parsed).not.toHaveProperty('WEB_CONCIERGE_TOKEN_SHA256');
  });

  it('requires the web bridge fingerprint in deployed environments', () => {
    // Given production omits the cross-runtime web credential fingerprint
    const source = {
      ...BASE_ENV,
      DEPLOYMENT_ENV: 'production',
      TELEGRAM_INGRESS: 'webhook',
      TELEGRAM_WEBHOOK_SECRET_TOKEN: 'webhook-secret-token-with-32-bytes',
      GLM_BASE_URL: 'https://api.z.ai/api/anthropic',
      SOLANA_RPC_URL: 'https://api.devnet.solana.com',
      WEB_BASE_URL: 'https://web.example.test',
      WALLET_LINK_DOMAIN: 'web.example.test',
    };

    // When the engine parses its deployed environment
    const parse = () => loadEnv(source);

    // Then startup fails without requiring the raw web credential
    expect(parse).toThrowError('Engine environment invalid: WEB_CONCIERGE_TOKEN_SHA256');
  });

  it('rejects malformed analytics key material', () => {
    // Given analytics HMAC material that is not a canonical 32-byte base64 key
    const source = { ...BASE_ENV, ANALYTICS_HMAC_SECRET: 'not-base64' };

    // When the engine parses its environment
    const parse = () => loadEnv(source);

    // Then startup names the secret variable without echoing its value
    expect(parse).toThrowError('Engine environment invalid: ANALYTICS_HMAC_SECRET');
  });

  it('rejects unsafe production transport settings before startup', () => {
    // Given production is configured for polling, plain HTTP, and no webhook secret
    const source = {
      ...BASE_ENV,
      DEPLOYMENT_ENV: 'production',
      GLM_BASE_URL: 'https://api.z.ai/api/anthropic',
      SOLANA_RPC_URL: 'https://api.devnet.solana.com',
    };

    // When the engine parses its environment
    const parse = () => loadEnv(source);

    // Then every unsafe transport variable is named without configuration values
    expect(parse).toThrowError(
      'Engine environment invalid: TELEGRAM_INGRESS, TELEGRAM_WEBHOOK_SECRET_TOKEN, WEB_BASE_URL',
    );
  });

  it('rejects a wallet link domain that differs from the configured web origin', () => {
    // Given account links would leave the configured web origin
    const source = { ...BASE_ENV, WALLET_LINK_DOMAIN: 'wallet.example.test' };

    // When the engine parses its environment
    const parse = () => loadEnv(source);

    // Then both origin variables are named and startup stops
    expect(parse).toThrowError(
      'Engine environment invalid: WALLET_LINK_DOMAIN, WEB_BASE_URL',
    );
  });

});
