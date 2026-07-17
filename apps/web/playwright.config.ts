import { defineConfig } from '@playwright/test';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3041';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const CONTROLLED_ENVIRONMENT_NAMES = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_SOLANA_RPC_URL',
  'NEXT_PUBLIC_TXORACLE_PROGRAM_ID',
  'NEXT_PUBLIC_TELEGRAM_BOT_USERNAME',
  'NEXT_PUBLIC_TELEGRAM_STARTGROUP',
  'CONCIERGE_WALLET_API_URL',
  'WEB_CONCIERGE_TOKEN',
  'ENGINE_CONCIERGE_TOKEN_SHA256',
  'ENGINE_TELEGRAM_TOKEN_SHA256',
  'ENGINE_OPS_TOKEN_SHA256',
  'WEB_BASE_URL',
  'WALLET_LINK_DOMAIN',
  'ANALYTICS_HMAC_SECRET',
  'STARTER_GRANTS_ENABLED',
  'WALLET_MINIAPP_ENABLED',
  'STAKE_ACCEPTANCE_ENABLED',
] as const;

class BrowserTestConfigurationError extends Error {
  readonly name = 'BrowserTestConfigurationError';

  constructor(readonly reason: string) {
    super(reason);
  }
}

function resolveBaseUrl(value: string | undefined): string {
  if (value === undefined) return DEFAULT_BASE_URL;

  const parsed = new URL(value);
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    !LOOPBACK_HOSTS.has(parsed.hostname) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new BrowserTestConfigurationError(
      'E2E_BASE_URL must be a loopback HTTP(S) origin without credentials or a path',
    );
  }
  return parsed.origin;
}

function createBrowserTestEnvironment(): Record<string, string> {
  const inherited = Object.entries(process.env).reduce<Record<string, string>>(
    (environment, [name, value]) => {
      if (value !== undefined && !CONTROLLED_ENVIRONMENT_NAMES.some((controlledName) => controlledName === name)) {
        environment[name] = value;
      }
      return environment;
    },
    {},
  );
  return {
    ...inherited,
    NODE_ENV: process.env.NODE_ENV ?? 'production',
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:65535',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'browser-test-anon-key',
    NEXT_PUBLIC_SOLANA_RPC_URL: 'http://127.0.0.1:65535',
    NEXT_PUBLIC_TXORACLE_PROGRAM_ID: '11111111111111111111111111111111',
    NEXT_PUBLIC_TELEGRAM_BOT_USERNAME: 'calledit_test_bot',
    NEXT_PUBLIC_TELEGRAM_STARTGROUP: 'calledit_v1',
    STARTER_GRANTS_ENABLED: 'false',
    WALLET_MINIAPP_ENABLED: 'false',
    STAKE_ACCEPTANCE_ENABLED: 'false',
  };
}

const suppliedBaseUrl = process.env.E2E_BASE_URL;
const baseURL = resolveBaseUrl(suppliedBaseUrl);

export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  preserveOutput: 'always',
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],
  use: {
    baseURL,
    browserName: 'chromium',
    colorScheme: 'dark',
    locale: 'en-US',
    timezoneId: 'UTC',
    contextOptions: { reducedMotion: 'reduce' },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'phone-320', use: { viewport: { width: 320, height: 800 } } },
    { name: 'phone-375', use: { viewport: { width: 375, height: 812 } } },
    { name: 'tablet-768', use: { viewport: { width: 768, height: 1024 } } },
    { name: 'desktop-1280', use: { viewport: { width: 1280, height: 900 } } },
  ],
  ...(suppliedBaseUrl === undefined
    ? {
        webServer: {
          command:
            'npx -y pnpm@10.33.0 build && npx -y pnpm@10.33.0 exec next start --hostname 127.0.0.1 --port 3041',
          url: `${DEFAULT_BASE_URL}/`,
          timeout: 180_000,
          reuseExistingServer: false,
          env: createBrowserTestEnvironment(),
        },
      }
    : {}),
});
