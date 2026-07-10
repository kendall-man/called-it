import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSolanaConfig, getSupabaseConfig, loadWebEnv } from './env';

const BASE_ENV = {
  NODE_ENV: 'production',
  NEXT_PUBLIC_TELEGRAM_BOT_USERNAME: 'calledit_test_bot',
  NEXT_PUBLIC_TELEGRAM_STARTGROUP: 'calledit_v1',
  STARTER_GRANTS_ENABLED: 'false',
  WALLET_MINIAPP_ENABLED: 'false',
  STAKE_ACCEPTANCE_ENABLED: 'false',
} satisfies NodeJS.ProcessEnv;

describe('web environment', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('preserves development degradation when public data providers are unset', () => {
    // Given the optional public provider variables are absent
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');
    vi.stubEnv('NEXT_PUBLIC_SOLANA_RPC_URL', '');
    vi.stubEnv('NEXT_PUBLIC_TXORACLE_PROGRAM_ID', '');

    // When existing accessors read runtime configuration
    const supabase = getSupabaseConfig();
    const solana = getSolanaConfig();

    // Then pages retain their explicit awaiting-configuration state
    expect(supabase).toBeNull();
    expect(solana).toBeNull();
  });

  it('fails a production build when Telegram entry configuration is missing', async () => {
    // Given a production build without the public bot username or versioned payload
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_TELEGRAM_BOT_USERNAME', '');
    vi.stubEnv('NEXT_PUBLIC_TELEGRAM_STARTGROUP', '');

    // When Next loads its build configuration
    const build = () => import('../next.config');

    // Then build configuration fails before any page is compiled
    await expect(build()).rejects.toThrowError(
      'Web environment invalid: NEXT_PUBLIC_TELEGRAM_BOT_USERNAME, NEXT_PUBLIC_TELEGRAM_STARTGROUP',
    );
  });

  it('accepts a minimal production configuration with every capability disabled', () => {
    // Given the required Telegram entry variables and explicit disabled switches
    const source = { ...BASE_ENV };

    // When the web parser reads the production environment
    const parsed = loadWebEnv(source);

    // Then the versioned payload and typed disabled switches are preserved
    expect(parsed).toMatchObject({
      NEXT_PUBLIC_TELEGRAM_BOT_USERNAME: 'calledit_test_bot',
      NEXT_PUBLIC_TELEGRAM_STARTGROUP: 'calledit_v1',
      STARTER_GRANTS_ENABLED: false,
      WALLET_MINIAPP_ENABLED: false,
      STAKE_ACCEPTANCE_ENABLED: false,
    });
  });

  it('allows non-secret wallet origin metadata while the Mini App is disabled', () => {
    // Given aligned web origin metadata but no wallet bridge credentials
    const source = {
      ...BASE_ENV,
      WEB_BASE_URL: 'https://web.example.test',
      WALLET_LINK_DOMAIN: 'web.example.test',
    };

    // When the web parser reads the disabled configuration
    const parsed = loadWebEnv(source);

    // Then the capability remains off without requiring inactive dependencies
    expect(parsed.WALLET_MINIAPP_ENABLED).toBe(false);
  });

  it.each([
    {
      name: 'a stale Telegram start-group version',
      source: { ...BASE_ENV, NEXT_PUBLIC_TELEGRAM_STARTGROUP: 'calledit_v2' },
      variables: 'NEXT_PUBLIC_TELEGRAM_STARTGROUP',
    },
    {
      name: 'a malformed feature switch',
      source: { ...BASE_ENV, STAKE_ACCEPTANCE_ENABLED: 'yes' },
      variables: 'STAKE_ACCEPTANCE_ENABLED',
    },
    {
      name: 'starter grants while stake acceptance is disabled',
      source: { ...BASE_ENV, STARTER_GRANTS_ENABLED: 'true' },
      variables: 'STAKE_ACCEPTANCE_ENABLED, STARTER_GRANTS_ENABLED',
    },
    {
      name: 'the Mini App without its server-only configuration',
      source: { ...BASE_ENV, WALLET_MINIAPP_ENABLED: 'true' },
      variables: [
        'ANALYTICS_HMAC_SECRET',
        'CONCIERGE_WALLET_API_URL',
        'WALLET_LINK_DOMAIN',
        'WEB_BASE_URL',
        'WEB_CONCIERGE_TOKEN',
      ].join(', '),
    },
    {
      name: 'a server credential exposed with a public prefix',
      source: { ...BASE_ENV, NEXT_PUBLIC_WEB_CONCIERGE_TOKEN: 'do-not-disclose-this-token' },
      variables: 'NEXT_PUBLIC_WEB_CONCIERGE_TOKEN',
    },
    {
      name: 'an incomplete Supabase public pair',
      source: { ...BASE_ENV, NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co' },
      variables: 'NEXT_PUBLIC_SUPABASE_ANON_KEY, NEXT_PUBLIC_SUPABASE_URL',
    },
  ])('rejects $name with variable names only', ({ source, variables }) => {
    // Given an invalid or incomplete web environment boundary
    const parse = () => loadWebEnv(source);

    // When the web parser reads the environment
    const invoke = parse;

    // Then build startup fails with only the responsible variable names
    expect(invoke).toThrowError(`Web environment invalid: ${variables}`);
  });

  it('accepts a complete production Mini App server configuration', () => {
    // Given all wallet bridge values are server-only, HTTPS, and origin-aligned
    const source = {
      ...BASE_ENV,
      WALLET_MINIAPP_ENABLED: 'true',
      CONCIERGE_WALLET_API_URL: 'https://concierge.example.test',
      WEB_CONCIERGE_TOKEN: 'web-concierge-token-with-32-bytes-',
      WEB_BASE_URL: 'https://web.example.test',
      WALLET_LINK_DOMAIN: 'web.example.test',
      ANALYTICS_HMAC_SECRET: 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=',
    };

    // When the web parser reads the production environment
    const parsed = loadWebEnv(source);

    // Then the wallet capability is enabled without creating public secret fields
    expect(parsed.WALLET_MINIAPP_ENABLED).toBe(true);
    expect(parsed.WEB_CONCIERGE_TOKEN).toBe(source.WEB_CONCIERGE_TOKEN);
    expect(parsed).not.toHaveProperty('NEXT_PUBLIC_WEB_CONCIERGE_TOKEN');
  });

  it('rejects a token-bearing concierge wallet URL', () => {
    // Given a complete Mini App config with credential-like query data in its URL
    const source = {
      ...BASE_ENV,
      WALLET_MINIAPP_ENABLED: 'true',
      CONCIERGE_WALLET_API_URL: 'https://concierge.example.test?token=do-not-log',
      WEB_CONCIERGE_TOKEN: 'web-concierge-token-with-32-bytes-',
      WEB_BASE_URL: 'https://web.example.test',
      WALLET_LINK_DOMAIN: 'web.example.test',
      ANALYTICS_HMAC_SECRET: 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=',
    };

    // When the web parser reads the server-only bridge configuration
    const parse = () => loadWebEnv(source);

    // Then startup names the URL variable without reflecting query contents
    expect(parse).toThrowError('Web environment invalid: CONCIERGE_WALLET_API_URL');
  });
});
