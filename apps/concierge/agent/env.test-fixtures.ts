export const BASE_ENV = {
  DEPLOYMENT_ENV: 'development',
  GLM_API_KEY: 'glm-test-key',
  GLM_BASE_URL: 'https://api.z.ai/api/anthropic',
  TELEGRAM_BOT_TOKEN: '1234567890:test-bot-token',
  TELEGRAM_BOT_USERNAME: 'calledit_test_bot',
  TELEGRAM_WEBHOOK_SECRET_TOKEN: 'webhook-secret-token-with-32-bytes',
  ENGINE_PRIVATE_API_URL: 'http://engine.railway.internal:8790',
  ENGINE_CONCIERGE_TOKEN: 'concierge-route-token-with-32-bytes',
  ENGINE_TELEGRAM_TOKEN: 'telegram-route-token-with-32-bytes-',
  WEB_CONCIERGE_TOKEN: 'web-concierge-token-with-32-bytes-',
  WEB_BASE_URL: 'http://localhost:3000',
  WALLET_LINK_DOMAIN: 'localhost',
  ANALYTICS_HMAC_SECRET: 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=',
  STARTER_GRANTS_ENABLED: 'false',
  WALLET_MINIAPP_ENABLED: 'false',
  STAKE_ACCEPTANCE_ENABLED: 'false',
  READINESS_CHECK_TIMEOUT_MS: '5000',
  READINESS_ENGINE_TIMEOUT_MS: '3000',
  SHUTDOWN_DRAIN_TIMEOUT_MS: '12000',
  PORT: '8080',
} satisfies NodeJS.ProcessEnv;

export const CURRENT_MASTER = Buffer.alloc(32, 1).toString('base64');
export const PREVIOUS_MASTER = Buffer.alloc(32, 2).toString('base64');
export const NOW_EPOCH_MS = Date.parse('2026-07-10T00:00:00.000Z');
