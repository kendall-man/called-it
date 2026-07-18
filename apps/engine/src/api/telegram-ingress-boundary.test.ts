import { describe, expect, it } from 'vitest';
import type { Update } from 'grammy/types';
import { createTelegramIngressHandler } from './telegram-ingress-boundary.js';

describe('Telegram ingress boundary', () => {
  it('dispatches a valid text update to the bot mutation', async () => {
    // Given
    const received: Update[] = [];
    const handle = createTelegramIngressHandler(async (update) => {
      received.push(update);
    });
    const input = {
      update_id: 42,
      message: {
        message_id: 7,
        date: 1_720_000_000,
        chat: { id: -1001, type: 'supergroup', title: 'Rumble' },
        from: { id: 99, is_bot: false, first_name: 'Ada' },
        text: '/bookit',
        entities: [{ type: 'bot_command', offset: 0, length: 7 }],
        reply_to_message: {
          message_id: 6,
          date: 1_719_999_999,
          chat: { id: -1001, type: 'supergroup', title: 'Rumble' },
          from: { id: 98, is_bot: false, first_name: 'Grace' },
          text: 'France win today',
        },
      },
    };

    // When
    await handle(input);

    // Then
    expect(received).toEqual([input]);
  });

  it('rejects a malformed text update before bot mutation', async () => {
    // Given
    let mutationCount = 0;
    const handle = createTelegramIngressHandler(async () => {
      mutationCount += 1;
    });
    const input = {
      update_id: 43,
      message: {
        message_id: 8,
        date: 1_720_000_001,
        chat: { id: -1001, type: 'supergroup', title: 'Rumble' },
        from: { id: 99, is_bot: false, first_name: 'Ada', username: 123 },
        text: 'France win today',
      },
    };

    // When
    const result = handle(input);

    // Then
    await expect(result).rejects.toThrow();
    expect(mutationCount).toBe(0);
  });

  it('dispatches a valid callback update to the bot mutation', async () => {
    // Given
    const received: Update[] = [];
    const handle = createTelegramIngressHandler(async (update) => {
      received.push(update);
    });
    const input = {
      update_id: 44,
      callback_query: {
        id: 'callback-1',
        from: { id: 99, is_bot: false, first_name: 'Ada' },
        chat_instance: 'chat-instance-1',
        data: 'confirm:claim-1',
        message: {
          message_id: 9,
          date: 1_720_000_002,
          chat: { id: -1001, type: 'supergroup', title: 'Rumble' },
        },
      },
    };

    // When
    await handle(input);

    // Then
    expect(received).toEqual([input]);
  });

  it('dispatches a valid membership update to the bot mutation', async () => {
    // Given
    const received: Update[] = [];
    const handle = createTelegramIngressHandler(async (update) => {
      received.push(update);
    });
    const member = { id: 100, is_bot: true, first_name: 'Rumble' };
    const input = {
      update_id: 45,
      my_chat_member: {
        chat: { id: -1001, type: 'supergroup', title: 'Rumble' },
        from: { id: 99, is_bot: false, first_name: 'Ada' },
        date: 1_720_000_003,
        old_chat_member: { status: 'left', user: member },
        new_chat_member: { status: 'member', user: member },
      },
    };

    // When
    await handle(input);

    // Then
    expect(received).toEqual([input]);
  });
});
