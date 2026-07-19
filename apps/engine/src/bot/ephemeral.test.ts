import { describe, expect, it, vi } from 'vitest';
import { InlineKeyboard } from 'grammy';
import { createTelegramEphemeralPort } from './ephemeral.js';

describe('visible stake stepper transport', () => {
  it('sends and edits an ordinary group message so Telegram Web shows the controls', async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        method: String(url).split('/').at(-1) ?? '',
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      const method = calls.at(-1)?.method;
      return new Response(JSON.stringify({
        ok: true,
        result: method === 'sendMessage' ? { message_id: 44 } : true,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const port = createTelegramEphemeralPort({
      token: 'test-token',
      log: { warn: vi.fn() } as never,
      fetchImpl: fetchImpl as typeof fetch,
    });
    const keyboard = new InlineKeyboard().text('+', 'step');

    await expect(port.send({
      chatId: -1001,
      receiverUserId: 7,
      callbackQueryId: 'callback',
      text: 'Size it',
      replyMarkup: keyboard,
    })).resolves.toEqual({ ok: true, ephemeralMessageId: 44 });
    await expect(port.edit({
      userId: 7,
      ephemeralMessageId: 44,
      text: 'Sized',
      replyMarkup: keyboard,
    })).resolves.toBe(true);

    expect(calls).toEqual([
      expect.objectContaining({
        method: 'sendMessage',
        body: expect.objectContaining({ chat_id: -1001, text: 'Size it' }),
      }),
      expect.objectContaining({
        method: 'editMessageText',
        body: expect.objectContaining({ chat_id: -1001, message_id: 44, text: 'Sized' }),
      }),
    ]);
    expect(calls[0]?.body).not.toHaveProperty('receiver_user_id');
    expect(calls[0]?.body).not.toHaveProperty('callback_query_id');
  });
});
