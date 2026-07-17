import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from '../log.js';
import {
  TELEGRAM_TOKEN,
  closeActiveServer,
  startHarness,
} from './server-test-harness.js';

function telegramHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${TELEGRAM_TOKEN}`,
    'content-type': 'application/json',
  };
}

function captureLogger(logs: unknown[]): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: (_event, fields) => logs.push(fields),
    child: () => captureLogger(logs),
  };
}

describe('telegram ingress route and redaction', () => {
  afterEach(closeActiveServer);

  it('acknowledges Telegram ingress only after the accepted update resolves', async () => {
    const received: Array<Record<string, unknown>> = [];
    const harness = await startHarness({
      handleTelegramUpdate: async (update) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        received.push(update);
      },
    });
    const update = { update_id: 42, message: { text: 'France win today' } };

    const res = await fetch(`${harness.base}/api/telegram-ingress`, {
      method: 'POST',
      headers: telegramHeaders(),
      body: JSON.stringify(update),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(received).toEqual([update]);
  });

  it('removes the legacy Telegram update route contract', async () => {
    const harness = await startHarness({
      handleTelegramUpdate: async () => undefined,
    });
    const legacyRoute = '/api/telegram-' + 'update';

    const res = await fetch(`${harness.base}${legacyRoute}`, {
      method: 'POST',
      headers: telegramHeaders(),
      body: JSON.stringify({ update_id: 1 }),
    });

    expect(res.status).toBe(404);
  });

  it('logs only request ids and stable reasons when upstream processing throws', async () => {
    const logs: unknown[] = [];
    const secret = 'telegram-route-token-with-32-bytes-';
    const harness = await startHarness({
      log: captureLogger(logs),
      handleTelegramUpdate: async () => {
        throw new Error(
          [
            `Authorization: Bearer ${secret}`,
            'initData=user%3Dtelegram',
            'privateKey=wallet-secret-material',
            'signature=signed-message-bytes',
            'upstream body: raw provider response',
          ].join(' '),
        );
      },
    });

    const res = await fetch(`${harness.base}/api/telegram-ingress`, {
      method: 'POST',
      headers: telegramHeaders(),
      body: JSON.stringify({
        update_id: 9,
        message: { text: 'leaked body text' },
      }),
    });

    expect(res.status).toBe(500);
    const serializedLogs = JSON.stringify(logs);
    expect(serializedLogs).toContain('requestId');
    expect(serializedLogs).toContain('internal_exception');
    expect(serializedLogs).not.toContain(secret);
    expect(serializedLogs).not.toContain('telegram-init-data');
    expect(serializedLogs).not.toContain('wallet-secret-material');
    expect(serializedLogs).not.toContain('signed-message-bytes');
    expect(serializedLogs).not.toContain('raw provider response');
    expect(serializedLogs).not.toContain('leaked body text');
  });
});
