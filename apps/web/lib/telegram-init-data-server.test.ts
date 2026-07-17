import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TelegramInitDataError, verifyTelegramInitData } from './telegram-init-data-server';

const BOT_TOKEN = '123456789:test-bot-token-secret';
const NOW = new Date('2030-01-01T00:00:00.000Z');

function signedInitData(input: {
  readonly authDate?: number;
  readonly botToken?: string;
  readonly userId?: number;
} = {}): string {
  const fields = new URLSearchParams({
    auth_date: String(input.authDate ?? Math.floor(NOW.getTime() / 1_000)),
    query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
    user: JSON.stringify({
      id: input.userId ?? 42,
      first_name: 'Private',
      username: 'not_trusted_until_verified',
    }),
  });
  const dataCheckString = [...fields.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData')
    .update(input.botToken ?? BOT_TOKEN)
    .digest();
  fields.set('hash', createHmac('sha256', secret).update(dataCheckString).digest('hex'));
  return fields.toString();
}

describe('Telegram Mini App initData verification', () => {
  it('returns the authenticated Telegram user ID for fresh correctly signed data', () => {
    expect(verifyTelegramInitData(signedInitData(), {
      botToken: BOT_TOKEN,
      now: NOW,
    })).toEqual({ telegramUserId: 42 });
  });

  it('rejects data signed with a different bot token', () => {
    expect(() => verifyTelegramInitData(signedInitData({ botToken: 'different:bot-token' }), {
      botToken: BOT_TOKEN,
      now: NOW,
    })).toThrowError(new TelegramInitDataError('invalid'));
  });

  it('rejects data older than the bounded authentication window', () => {
    expect(() => verifyTelegramInitData(signedInitData({
      authDate: Math.floor(NOW.getTime() / 1_000) - 301,
    }), {
      botToken: BOT_TOKEN,
      now: NOW,
    })).toThrowError(new TelegramInitDataError('expired'));
  });

  it('rejects duplicate fields instead of validating an ambiguous identity', () => {
    const initData = `${signedInitData()}&user=${encodeURIComponent(JSON.stringify({ id: 99 }))}`;
    expect(() => verifyTelegramInitData(initData, {
      botToken: BOT_TOKEN,
      now: NOW,
    })).toThrowError(new TelegramInitDataError('invalid'));
  });
});
