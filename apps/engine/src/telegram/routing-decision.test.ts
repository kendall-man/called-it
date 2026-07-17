import { describe, expect, it } from 'vitest';
import { createTelegramRoutingPolicy } from './routing-decision.js';

describe('createTelegramRoutingPolicy', () => {
  it('routes member updates, callbacks, commands, engine-owned replies, and plain group text to the engine', async () => {
    const resolveOwnedReply = async (chatId: number, messageId: number) =>
      chatId === -1001 && messageId === 700 ? 'engine' : 'unknown';
    const policy = createTelegramRoutingPolicy({
      botUsername: 'CalledItBot',
      prefilter: async (text) => text.includes('France'),
      resolveOwnedReply,
    });

    await expect(
      policy({ update_id: 1, my_chat_member: { chat: { id: -1001, type: 'supergroup' } } }),
    ).resolves.toBe('pending_engine');
    await expect(
      policy({ update_id: 2, callback_query: { id: 'cb-1', data: 'x' } }),
    ).resolves.toBe('pending_engine');
    await expect(
      policy({
        update_id: 3,
        message: {
          message_id: 9,
          chat: { id: 10, type: 'private' },
          text: '/me',
          entities: [{ type: 'bot_command', offset: 0, length: 3 }],
        },
      }),
    ).resolves.toBe('pending_engine');
    await expect(
      policy({
        update_id: 4,
        message: {
          message_id: 10,
          chat: { id: -1001, type: 'supergroup' },
          text: 'reply',
          reply_to_message: { message_id: 700 },
        },
      }),
    ).resolves.toBe('pending_engine');
    await expect(
      policy({
        update_id: 5,
        message: {
          message_id: 11,
          chat: { id: -1001, type: 'supergroup' },
          text: 'France win today',
        },
      }),
    ).resolves.toBe('pending_engine');
  });

  it('routes conversational replies and non-claim mentions to concierge, but claim-like mentions to the engine', async () => {
    const policy = createTelegramRoutingPolicy({
      botUsername: 'CalledItBot',
      prefilter: async (text) => text.includes('France'),
      resolveOwnedReply: async () => 'unknown',
    });

    await expect(
      policy({
        update_id: 6,
        message: {
          message_id: 12,
          chat: { id: -1001, type: 'supergroup' },
          text: 'what do you think',
          reply_to_message: { message_id: 800 },
        },
      }),
    ).resolves.toBe('routed_concierge');
    await expect(
      policy({
        update_id: 7,
        message: {
          message_id: 13,
          chat: { id: -1001, type: 'supergroup' },
          text: '@CalledItBot hello there',
        },
      }),
    ).resolves.toBe('routed_concierge');
    await expect(
      policy({
        update_id: 8,
        message: {
          message_id: 14,
          chat: { id: -1001, type: 'supergroup' },
          text: '@CalledItBot France win today',
        },
      }),
    ).resolves.toBe('pending_engine');
    await expect(
      policy({
        update_id: 9,
        message: {
          message_id: 15,
          chat: { id: 10, type: 'private' },
          text: 'hello there',
        },
      }),
    ).resolves.toBe('routed_concierge');
  });
});
