import { describe, expect, it, vi } from 'vitest';
import { InlineKeyboard } from 'grammy';
import { createTelegramEphemeralPort } from './ephemeral.js';

describe('visible stake stepper transport', () => {
  it('sends and edits an ordinary group message so Telegram Web shows the controls', async () => {
    const sendMessage = vi.fn(async () => ({ message_id: 44 }));
    const editMessageText = vi.fn(async () => true);
    const port = createTelegramEphemeralPort({
      api: { sendMessage, editMessageText } as never,
      log: { warn: vi.fn() } as never,
      queue: {
        enqueueInteractive: async (_chatId: number, task: () => Promise<unknown>) => task(),
      } as never,
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

    expect(sendMessage).toHaveBeenCalledWith(-1001, 'Size it', expect.objectContaining({
      reply_markup: keyboard,
    }));
    expect(editMessageText).toHaveBeenCalledWith(-1001, 44, 'Sized', expect.objectContaining({
      reply_markup: keyboard,
    }));
  });
});
