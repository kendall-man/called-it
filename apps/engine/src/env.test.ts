import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { loadEnv } from './env.js';
import { BASE_ENV } from './env.test-fixtures.js';

const DEVNET_ESCROW_PROGRAM_ID = 'HrKUo8Bue31kU9sobzQGK5qDxVxBu5nBLXP3aGeKCDFL';
const DISTINCT_MAINNET_TEST_PROGRAM_ID = 'BPFLoaderUpgradeab1e11111111111111111111111';
const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function completeEscrowEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const mainnet = overrides.SOLANA_NETWORK === 'mainnet-beta';
  return {
    ...BASE_ENV,
    WAGER_CUSTODY_MODE: 'escrow',
    ESCROW_ALLOWED_GROUP_IDS: '-100123',
    ESCROW_PROGRAM_ID: mainnet ? DISTINCT_MAINNET_TEST_PROGRAM_ID : DEVNET_ESCROW_PROGRAM_ID,
    ESCROW_GENESIS_HASH: mainnet ? MAINNET_GENESIS_HASH : DEVNET_GENESIS_HASH,
    ESCROW_CANONICAL_USDC_MINT: '22222222222222222222222222222222',
    ESCROW_CLASSIC_TOKEN_PROGRAM_ID: '33333333333333333333333333333333',
    ESCROW_ORACLE_SET_PDA: '44444444444444444444444444444444',
    ESCROW_ORACLE_SET_EPOCH: '7',
    ESCROW_ORACLE_THRESHOLD: '2',
    ESCROW_ORACLE_SIGNERS: [
      '55555555555555555555555555555555',
      '66666666666666666666666666666666',
      '77777777777777777777777777777777',
    ].join(','),
    ESCROW_ORACLE_SIGNER_ENDPOINTS_JSON: JSON.stringify([
      { url: 'https://oracle-1.example.test/sign', bearerToken: 'oracle-token-1' },
      { url: 'https://oracle-2.example.test/sign', bearerToken: 'oracle-token-2' },
      { url: 'https://oracle-3.example.test/sign', bearerToken: 'oracle-token-3' },
    ]),
    ESCROW_INDEXER_MAX_LAG_SLOTS: '32',
    ESCROW_CONFIG_AUTHORITY: '88888888888888888888888888888888',
    ESCROW_PAUSE_AUTHORITY: '99999999999999999999999999999999',
    ESCROW_MARKET_CREATION_AUTHORITY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    ESCROW_MARKET_AUTHORITY_KEYPAIR_B58: 'devnet-market-authority-secret',
    ESCROW_UPGRADE_AUTHORITY: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    ESCROW_RESIDUAL_RECIPIENT: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    ESCROW_RELAYER_KEYPAIR_B58: 'devnet-relayer-secret',
    ESCROW_FEED_OPERATOR_KEYPAIR_B58: 'devnet-feed-operator-secret',
    ...overrides,
  };
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
      WAGER_RUNTIME_MODE: 'disabled',
      WAGER_CUSTODY_MODE: 'legacy',
      WAGER_MODE_ENABLED: 'false',
      ESCROW_INDEXER_PAGE_SIZE: 1,
      ESCROW_WORKER_INTERVAL_MS: 5_000,
      ESCROW_MAINNET_ENABLED: false,
      ESCROW_ALLOWED_GROUP_IDS: [],
      BETA_ALLOWED_GROUP_IDS: [],
    });
  });

  it('fails closed when escrow custody is selected without its deployment contract', () => {
    expect(() => loadEnv({
      ...BASE_ENV,
      WAGER_CUSTODY_MODE: 'escrow',
    })).toThrowError(
      'Engine environment invalid: ESCROW_CANONICAL_USDC_MINT, ESCROW_CLASSIC_TOKEN_PROGRAM_ID, ESCROW_CONFIG_AUTHORITY, ESCROW_FEED_OPERATOR_KEYPAIR_B58, ESCROW_GENESIS_HASH, ESCROW_INDEXER_MAX_LAG_SLOTS, ESCROW_MARKET_AUTHORITY_KEYPAIR_B58, ESCROW_MARKET_AUTHORITY_SIGNER_ENDPOINT_JSON, ESCROW_MARKET_CREATION_AUTHORITY, ESCROW_ORACLE_LOCAL_KEYPAIRS_B58_JSON, ESCROW_ORACLE_SET_EPOCH, ESCROW_ORACLE_SET_PDA, ESCROW_ORACLE_SIGNERS, ESCROW_ORACLE_SIGNER_ENDPOINTS_JSON, ESCROW_ORACLE_THRESHOLD, ESCROW_PAUSE_AUTHORITY, ESCROW_PROGRAM_ID, ESCROW_RELAYER_KEYPAIR_B58, ESCROW_RESIDUAL_RECIPIENT, ESCROW_UPGRADE_AUTHORITY',
    );
  });

  it('parses a complete devnet escrow deployment contract', () => {
    const parsed = loadEnv(completeEscrowEnv({
      ESCROW_ALLOWED_GROUP_IDS: '-100123,-100456',
      ESCROW_INDEXER_PAGE_SIZE: '7',
      ESCROW_WORKER_INTERVAL_MS: '7500',
    }));

    expect(parsed).toMatchObject({
      WAGER_CUSTODY_MODE: 'escrow',
      ESCROW_ALLOWED_GROUP_IDS: [-100123, -100456],
      ESCROW_ORACLE_SET_EPOCH: 7n,
      ESCROW_ORACLE_THRESHOLD: 2,
      ESCROW_INDEXER_MAX_LAG_SLOTS: 32n,
      ESCROW_INDEXER_PAGE_SIZE: 7,
      ESCROW_WORKER_INTERVAL_MS: 7_500,
      ESCROW_MAINNET_ENABLED: false,
      ESCROW_MARKET_AUTHORITY_KEYPAIR_B58: 'devnet-market-authority-secret',
    });
    expect(parsed.ESCROW_ORACLE_SIGNERS).toHaveLength(3);
    expect(parsed.ESCROW_ORACLE_SIGNER_ENDPOINTS_JSON).toHaveLength(3);
    expect(parsed.ESCROW_GENESIS_HASH).toBe('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
  });

  it('keeps escrow recovery bootable with no intake groups after rollout rollback', () => {
    const parsed = loadEnv(completeEscrowEnv({
      ESCROW_ALLOWED_GROUP_IDS: '',
      STAKE_ACCEPTANCE_ENABLED: 'false',
    }));

    expect(parsed).toMatchObject({
      WAGER_CUSTODY_MODE: 'escrow',
      ESCROW_ALLOWED_GROUP_IDS: [],
      STAKE_ACCEPTANCE_ENABLED: false,
    });
  });

  it('requires an escrow group allowlist when position intake is enabled', () => {
    expect(() => loadEnv(completeEscrowEnv({
      ESCROW_ALLOWED_GROUP_IDS: '',
      WAGER_RUNTIME_MODE: 'funded',
      WAGER_MODE_ENABLED: 'true',
      STAKE_ACCEPTANCE_ENABLED: 'true',
    }))).toThrowError('Engine environment invalid: ESCROW_ALLOWED_GROUP_IDS');
  });

  it('rejects mainnet escrow until a separately compiled program identity is pinned', () => {
    const mainnetEscrow = completeEscrowEnv({
      DEPLOYMENT_ENV: 'production',
      BETA_ALLOWED_GROUP_IDS: '-100123',
      GLM_BASE_URL: 'https://api.z.ai/api/anthropic',
      SOLANA_NETWORK: 'mainnet-beta',
      SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com',
      WEB_BASE_URL: 'https://web.example.test',
      WALLET_LINK_DOMAIN: 'web.example.test',
      WAGER_RUNTIME_MODE: 'funded',
      WAGER_MODE_ENABLED: 'true',
      STARTER_GRANTS_ENABLED: 'false',
      STAKE_ACCEPTANCE_ENABLED: 'true',
      WALLET_MINIAPP_ENABLED: 'true',
      TREASURY_COVERAGE_ENFORCED: 'false',
      WAGER_TREASURY_KEYPAIR_B58: undefined,
      ESCROW_MAINNET_ENABLED: 'true',
      ESCROW_MARKET_AUTHORITY_KEYPAIR_B58: undefined,
      ESCROW_MARKET_AUTHORITY_SIGNER_ENDPOINT_JSON: JSON.stringify({
        url: 'https://market-authority.example.test/sign',
        bearerToken: 'market-authority-token',
      }),
    });

    expect(() => loadEnv(mainnetEscrow)).toThrowError(
      'Engine environment invalid: ESCROW_PROGRAM_ID, WAGER_CUSTODY_MODE',
    );
  });

  it('rejects an escrow genesis crossed with the selected network', () => {
    expect(() => loadEnv(completeEscrowEnv({
      ESCROW_GENESIS_HASH: MAINNET_GENESIS_HASH,
    }))).toThrowError('Engine environment invalid: ESCROW_GENESIS_HASH, SOLANA_NETWORK');
  });

  it('rejects a duplicate or insufficient escrow oracle set', () => {
    const shared = '55555555555555555555555555555555';
    const source = {
      ...BASE_ENV,
      WAGER_CUSTODY_MODE: 'escrow',
      ESCROW_ALLOWED_GROUP_IDS: '-100123',
      ESCROW_PROGRAM_ID: '11111111111111111111111111111111',
      ESCROW_GENESIS_HASH: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
      ESCROW_CANONICAL_USDC_MINT: '22222222222222222222222222222222',
      ESCROW_CLASSIC_TOKEN_PROGRAM_ID: '33333333333333333333333333333333',
      ESCROW_ORACLE_SET_PDA: '44444444444444444444444444444444',
      ESCROW_ORACLE_SET_EPOCH: '7',
      ESCROW_ORACLE_THRESHOLD: '2',
      ESCROW_ORACLE_SIGNERS: `${shared},${shared}`,
      ESCROW_ORACLE_SIGNER_ENDPOINTS_JSON: JSON.stringify([
        { url: 'https://oracle-1.example.test/sign' },
        { url: 'https://oracle-2.example.test/sign' },
        { url: 'https://oracle-3.example.test/sign' },
      ]),
      ESCROW_INDEXER_MAX_LAG_SLOTS: '32',
      ESCROW_CONFIG_AUTHORITY: '88888888888888888888888888888888',
      ESCROW_PAUSE_AUTHORITY: '99999999999999999999999999999999',
      ESCROW_MARKET_CREATION_AUTHORITY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      ESCROW_MARKET_AUTHORITY_KEYPAIR_B58: 'devnet-market-authority-secret',
      ESCROW_UPGRADE_AUTHORITY: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      ESCROW_RESIDUAL_RECIPIENT: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
      ESCROW_RELAYER_KEYPAIR_B58: 'devnet-relayer-secret',
      ESCROW_FEED_OPERATOR_KEYPAIR_B58: 'devnet-feed-operator-secret',
    };

    expect(() => loadEnv(source)).toThrowError(
      'Engine environment invalid: ESCROW_ORACLE_SIGNERS, ESCROW_ORACLE_THRESHOLD',
    );
  });

  it('rejects local oracle key injection on mainnet before runtime boot', () => {
    expect(() => loadEnv(completeEscrowEnv({
      DEPLOYMENT_ENV: 'production',
      BETA_ALLOWED_GROUP_IDS: '-100123',
      GLM_BASE_URL: 'https://api.z.ai/api/anthropic',
      SOLANA_NETWORK: 'mainnet-beta',
      SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com',
      WEB_BASE_URL: 'https://web.example.test',
      WALLET_LINK_DOMAIN: 'web.example.test',
      WAGER_RUNTIME_MODE: 'funded',
      WAGER_MODE_ENABLED: 'true',
      STARTER_GRANTS_ENABLED: 'false',
      STAKE_ACCEPTANCE_ENABLED: 'true',
      TREASURY_COVERAGE_ENFORCED: 'false',
      ESCROW_MAINNET_ENABLED: 'true',
      ESCROW_ORACLE_SIGNER_ENDPOINTS_JSON: '',
      ESCROW_ORACLE_LOCAL_KEYPAIRS_B58_JSON: JSON.stringify(['key-1', 'key-2', 'key-3']),
    }))).toThrowError(/ESCROW_ORACLE_LOCAL_KEYPAIRS_B58_JSON/);
  });

  it('rejects local market-authority keys on mainnet before runtime boot', () => {
    expect(() => loadEnv(completeEscrowEnv({
      DEPLOYMENT_ENV: 'production', BETA_ALLOWED_GROUP_IDS: '-100123',
      GLM_BASE_URL: 'https://api.z.ai/api/anthropic', SOLANA_NETWORK: 'mainnet-beta',
      SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com', WEB_BASE_URL: 'https://web.example.test',
      WALLET_LINK_DOMAIN: 'web.example.test', WAGER_RUNTIME_MODE: 'funded', WAGER_MODE_ENABLED: 'true',
      STARTER_GRANTS_ENABLED: 'false', STAKE_ACCEPTANCE_ENABLED: 'true',
      TREASURY_COVERAGE_ENFORCED: 'false', ESCROW_MAINNET_ENABLED: 'true',
    }))).toThrowError(/ESCROW_MARKET_AUTHORITY_KEYPAIR_B58/);
  });

  it('requires authenticated remote market-authority signing on mainnet', () => {
    expect(() => loadEnv(completeEscrowEnv({
      DEPLOYMENT_ENV: 'production', BETA_ALLOWED_GROUP_IDS: '-100123',
      GLM_BASE_URL: 'https://api.z.ai/api/anthropic', SOLANA_NETWORK: 'mainnet-beta',
      SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com', WEB_BASE_URL: 'https://web.example.test',
      WALLET_LINK_DOMAIN: 'web.example.test', WAGER_RUNTIME_MODE: 'funded', WAGER_MODE_ENABLED: 'true',
      STARTER_GRANTS_ENABLED: 'false', STAKE_ACCEPTANCE_ENABLED: 'true',
      TREASURY_COVERAGE_ENFORCED: 'false', ESCROW_MAINNET_ENABLED: 'true',
      ESCROW_MARKET_AUTHORITY_KEYPAIR_B58: undefined,
      ESCROW_MARKET_AUTHORITY_SIGNER_ENDPOINT_JSON: JSON.stringify({
        url: 'https://market-authority.example.test/sign',
      }),
    }))).toThrowError(/ESCROW_MARKET_AUTHORITY_SIGNER_ENDPOINT_JSON/);
  });

  it('rejects market-authority endpoint and secret reuse', () => {
    expect(() => loadEnv(completeEscrowEnv({
      ESCROW_MARKET_AUTHORITY_KEYPAIR_B58: undefined,
      ESCROW_MARKET_AUTHORITY_SIGNER_ENDPOINT_JSON: JSON.stringify({
        url: 'https://oracle-1.example.test/market-sign', bearerToken: 'oracle-token-1',
      }),
    }))).toThrowError(/ESCROW_MARKET_AUTHORITY_SIGNER_ENDPOINT_JSON/);
    expect(() => loadEnv(completeEscrowEnv({
      ESCROW_MARKET_AUTHORITY_KEYPAIR_B58: 'devnet-relayer-secret',
    }))).toThrowError(/ESCROW_MARKET_AUTHORITY_KEYPAIR_B58/);
  });

  it('treats an explicitly blank proof signer as disabled', () => {
    const parsed = loadEnv({ ...BASE_ENV, SOLANA_KEYPAIR_B58: '' });

    expect(parsed.SOLANA_KEYPAIR_B58).toBeUndefined();
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

  it('accepts a complete production starter-only beta configuration', () => {
    // Given direct engine polling with starter intake and no funded custody
    const source = {
      ...BASE_ENV,
      DEPLOYMENT_ENV: 'production',
      TELEGRAM_INGRESS: 'poll',
      BETA_ALLOWED_GROUP_IDS: '-100123',
      GLM_BASE_URL: 'https://api.z.ai/api/anthropic',
      SOLANA_RPC_URL: 'https://api.devnet.solana.com',
      WEB_BASE_URL: 'https://web.example.test',
      WALLET_LINK_DOMAIN: 'web.example.test',
      WAGER_RUNTIME_MODE: 'starter_only',
      WAGER_MODE_ENABLED: 'true',
      TREASURY_COVERAGE_ENFORCED: 'false',
      STAKE_ACCEPTANCE_ENABLED: 'true',
      STARTER_GRANTS_ENABLED: 'true',
      WALLET_MINIAPP_ENABLED: 'false',
    };

    // When the engine parses its environment
    const parsed = loadEnv(source);

    // Then starter capability is enabled as typed state without treasury custody
    expect(parsed).toMatchObject({
      BETA_ALLOWED_GROUP_IDS: [-100123],
      STARTER_GRANTS_ENABLED: true,
      WALLET_MINIAPP_ENABLED: false,
      STAKE_ACCEPTANCE_ENABLED: true,
      TREASURY_COVERAGE_ENFORCED: false,
    });
  });

  it('requires a valid non-empty group allowlist outside development', () => {
    const deployed = {
      ...BASE_ENV,
      DEPLOYMENT_ENV: 'production',
      TELEGRAM_INGRESS: 'poll',
      GLM_BASE_URL: 'https://api.z.ai/api/anthropic',
      SOLANA_RPC_URL: 'https://api.devnet.solana.com',
      WEB_BASE_URL: 'https://web.example.test',
      WALLET_LINK_DOMAIN: 'web.example.test',
      WAGER_RUNTIME_MODE: 'disabled',
    };

    expect(() => loadEnv(deployed)).toThrowError('Engine environment invalid: BETA_ALLOWED_GROUP_IDS');
    expect(() => loadEnv({ ...deployed, BETA_ALLOWED_GROUP_IDS: '100123' })).toThrowError(
      'Engine environment invalid: BETA_ALLOWED_GROUP_IDS',
    );
    expect(
      loadEnv({ ...deployed, BETA_ALLOWED_GROUP_IDS: '-100123, -100456' })
        .BETA_ALLOWED_GROUP_IDS,
    ).toEqual([-100123, -100456]);
  });

  it('rejects omitted provider URLs in production instead of applying local defaults', () => {
    // Given an otherwise valid production environment without explicit providers
    const source = {
      ...BASE_ENV,
      DEPLOYMENT_ENV: 'production',
      TELEGRAM_INGRESS: 'poll',
      BETA_ALLOWED_GROUP_IDS: '-100123',
      WEB_BASE_URL: 'https://web.example.test',
      WALLET_LINK_DOMAIN: 'web.example.test',
      WAGER_RUNTIME_MODE: 'disabled',
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

  it('retains the web credential fingerprint for the escrow presentation boundary', () => {
    // Given a distinct web bridge credential fingerprint is visible in a shared environment
    const source = {
      ...BASE_ENV,
      WEB_CONCIERGE_TOKEN_SHA256: sha256('distinct-web-bridge-token-with-32-bytes'),
    };

    // When the engine parser audits and returns runtime config
    const parsed = loadEnv(source);

    // Then the API boundary receives the validated digest without exposing the token
    expect(parsed.WEB_CONCIERGE_TOKEN_SHA256).toBe(
      sha256('distinct-web-bridge-token-with-32-bytes'),
    );
  });

  it('does not require a deferred web bridge fingerprint in the beta', () => {
    // Given production does not configure the deferred web bridge
    const source = {
      ...BASE_ENV,
      DEPLOYMENT_ENV: 'production',
      TELEGRAM_INGRESS: 'poll',
      BETA_ALLOWED_GROUP_IDS: '-100123',
      GLM_BASE_URL: 'https://api.z.ai/api/anthropic',
      SOLANA_RPC_URL: 'https://api.devnet.solana.com',
      WEB_BASE_URL: 'https://web.example.test',
      WALLET_LINK_DOMAIN: 'web.example.test',
      WAGER_RUNTIME_MODE: 'disabled',
    };

    // Then direct beta startup succeeds without a bridge credential.
    expect(loadEnv(source).TELEGRAM_INGRESS).toBe('poll');
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
    // Given production has an unsafe public web origin
    const source = {
      ...BASE_ENV,
      DEPLOYMENT_ENV: 'production',
      BETA_ALLOWED_GROUP_IDS: '-100123',
      GLM_BASE_URL: 'https://api.z.ai/api/anthropic',
      SOLANA_RPC_URL: 'https://api.devnet.solana.com',
      WAGER_RUNTIME_MODE: 'disabled',
    };

    // When the engine parses its environment
    const parse = () => loadEnv(source);

    // Then startup names the unsafe origin without requiring deferred webhook state.
    expect(parse).toThrowError('Engine environment invalid: WEB_BASE_URL');
  });

  it.each([
    ['localhost', 'https://localhost', 'localhost'],
    ['a loopback address', 'https://127.0.0.1', '127.0.0.1'],
    ['a private 10/8 address', 'https://10.23.45.67', '10.23.45.67'],
    ['a private 172.16/12 address', 'https://172.16.0.1', '172.16.0.1'],
    ['a private 192.168/16 address', 'https://192.168.1.1', '192.168.1.1'],
    ['non-HTTPS transport', 'http://web.example.test', 'web.example.test'],
  ])('rejects an allowlisted development beta origin using %s', (_case, webBaseUrl, domain) => {
    // Given local development has become an active allowlisted beta
    const source = {
      ...BASE_ENV,
      BETA_ALLOWED_GROUP_IDS: '-100123',
      WEB_BASE_URL: webBaseUrl,
      WALLET_LINK_DOMAIN: domain,
    };

    // When the engine validates its startup environment
    const parse = () => loadEnv(source);

    // Then it rejects only the unsafe public board origin
    expect(parse).toThrowError(/^Engine environment invalid: WEB_BASE_URL$/);
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
