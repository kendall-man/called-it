import assert from 'node:assert/strict';
import test from 'node:test';

import {
  configureProductionWebhook,
  productionWebhookUrl,
} from './production-telegram-webhook.mjs';

const ENV = {
  DEPLOYMENT_ENV: 'production',
  RAILWAY_PUBLIC_DOMAIN: 'engine.example.test',
  TELEGRAM_BOT_TOKEN: 'test-bot-token',
  TELEGRAM_WEBHOOK_SECRET_TOKEN: 's'.repeat(32),
};

test('production webhook is derived only from the Railway service domain', () => {
  assert.equal(
    productionWebhookUrl(ENV),
    'https://engine.example.test/api/telegram-webhook',
  );
  assert.throws(
    () => productionWebhookUrl({ ...ENV, RAILWAY_PUBLIC_DOMAIN: 'https://attacker.test/path' }),
    /RAILWAY_PUBLIC_DOMAIN/,
  );
});

test('production registration uses the same Railway environment token and secret', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith('/setWebhook')) {
      return { ok: true, json: async () => ({ ok: true, result: true }) };
    }
    return {
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          url: 'https://engine.example.test/api/telegram-webhook',
          pending_update_count: 0,
        },
      }),
    };
  };

  const result = await configureProductionWebhook(ENV, fetchImpl);
  const registration = JSON.parse(requests[0].init.body);
  assert.equal(registration.secret_token, ENV.TELEGRAM_WEBHOOK_SECRET_TOKEN);
  assert.equal(registration.drop_pending_updates, false);
  assert.deepEqual(result, {
    configured: true,
    endpoint: 'engine.example.test/api/telegram-webhook',
    pending: 0,
    lastError: null,
  });
});
