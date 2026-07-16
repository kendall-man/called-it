import { afterEach, describe, expect, it } from 'vitest';
import {
  TELEGRAM_TOKEN,
  closeActiveServer,
  startHarness,
} from './server-test-harness.js';

const telegramHeaders = {
  authorization: `Bearer ${TELEGRAM_TOKEN}`,
  'content-type': 'application/json',
};
const webhookSecret = 'telegram-webhook-secret-token-value';

afterEach(closeActiveServer);

describe('telegram ingress', () => {
  it('delivers the raw update to the handler before acknowledging', async () => {
    const received: Array<Record<string, unknown>> = [];
    const harness = await startHarness({
      handleTelegramUpdate: async (update) => {
        received.push(update);
      },
    });
    const update = { update_id: 42, message: { text: 'France win today', chat: { id: -1 } } };

    const res = await fetch(`${harness.base}/api/telegram-ingress`, {
      method: 'POST',
      headers: telegramHeaders,
      body: JSON.stringify(update),
    });

    expect(res.status).toBe(200);
    expect(received).toEqual([update]);
  });

  it('rejects unauthenticated forwards', async () => {
    const received: Array<Record<string, unknown>> = [];
    const harness = await startHarness({
      handleTelegramUpdate: async (update) => {
        received.push(update);
      },
    });

    const res = await fetch(`${harness.base}/api/telegram-ingress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ update_id: 1 }),
    });

    expect(res.status).toBe(401);
    expect(received).toEqual([]);
  });

  it('accepts Telegram webhooks authenticated by the Bot API secret header', async () => {
    const received: Array<Record<string, unknown>> = [];
    const harness = await startHarness({
      env: {
        TELEGRAM_INGRESS: 'webhook',
        TELEGRAM_WEBHOOK_SECRET_TOKEN: webhookSecret,
      },
      handleTelegramUpdate: async (update) => {
        received.push(update);
      },
    });
    const update = { update_id: 43, message: { text: '/testmatch', chat: { id: -1 } } };

    const res = await fetch(`${harness.base}/api/telegram-webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': webhookSecret,
      },
      body: JSON.stringify(update),
    });

    expect(res.status).toBe(200);
    expect(received).toEqual([update]);
  });

  it('rejects Telegram webhooks with a missing or incorrect secret', async () => {
    const received: Array<Record<string, unknown>> = [];
    const harness = await startHarness({
      env: {
        TELEGRAM_INGRESS: 'webhook',
        TELEGRAM_WEBHOOK_SECRET_TOKEN: webhookSecret,
      },
      handleTelegramUpdate: async (update) => {
        received.push(update);
      },
    });

    const res = await fetch(`${harness.base}/api/telegram-webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'incorrect-webhook-secret-token-value',
      },
      body: JSON.stringify({ update_id: 44 }),
    });

    expect(res.status).toBe(401);
    expect(received).toEqual([]);
  });
});
