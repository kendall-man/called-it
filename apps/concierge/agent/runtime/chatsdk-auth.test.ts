import { describe, expect, it } from 'vitest';
import { telegramIdentity } from '../lib/engine-api.js';
import {
  extractTelegramWebhookIdentity,
  telegramWebhookPrincipal,
  telegramWebhookPrincipalFromRawMessage,
} from './chatsdk-auth.js';

describe('telegram-webhook principal builder', () => {
  it('round-trips through telegramIdentity to the same chat/user/username', () => {
    // Given a trusted private-chat identity
    const principal = telegramWebhookPrincipal({
      chatId: 555123,
      userId: 555123,
      username: 'alice',
    });

    // When eve stores it at session.auth.current and a tool reads identity
    const identity = telegramIdentity({ auth: { current: principal } });

    // Then telegramIdentity recovers exactly what was authenticated
    expect(identity).toEqual({ chatId: 555123, userId: 555123, username: 'alice' });
  });

  it('omits username when the sender has none (identity resolves it to null)', () => {
    const principal = telegramWebhookPrincipal({
      chatId: 42,
      userId: 99,
      username: null,
    });

    expect(principal.attributes).not.toHaveProperty('username');
    expect(telegramIdentity({ auth: { current: principal } })).toEqual({
      chatId: 42,
      userId: 99,
      username: null,
    });
  });

  it('tags the principal as a telegram-webhook user (trusted by telegramIdentity)', () => {
    const principal = telegramWebhookPrincipal({ chatId: 7, userId: 7, username: null });
    expect(principal.authenticator).toBe('telegram-webhook');
    expect(principal.principalType).toBe('user');
    expect(principal.principalId).toBe('telegram:7');
    // Attribute values are strings, matching eve's SessionAuthContext contract.
    expect(principal.attributes.chat_id).toBe('7');
    expect(principal.attributes.user_id).toBe('7');
  });
});

describe('extractTelegramWebhookIdentity', () => {
  it('reads ids and username from a raw Telegram message payload', () => {
    const raw = {
      message_id: 12,
      chat: { id: 555123, type: 'private' },
      from: { id: 555123, is_bot: false, username: 'alice', first_name: 'Alice' },
      text: 'what calls are open?',
    };
    expect(extractTelegramWebhookIdentity(raw)).toEqual({
      chatId: 555123,
      userId: 555123,
      username: 'alice',
    });
  });

  it('coerces stringified numeric ids and defaults a missing username to null', () => {
    const raw = { chat: { id: '-1001' }, from: { id: '4242' } };
    expect(extractTelegramWebhookIdentity(raw)).toEqual({
      chatId: -1001,
      userId: 4242,
      username: null,
    });
  });

  it.each([
    ['no chat', { from: { id: 1 } }],
    ['no from', { chat: { id: 1 } }],
    ['non-numeric ids', { chat: { id: 'x' }, from: { id: 'y' } }],
    ['not an object', 'nope'],
    ['null', null],
  ])('returns null when identity is untrusted or missing (%s)', (_name, raw) => {
    expect(extractTelegramWebhookIdentity(raw)).toBeNull();
    expect(telegramWebhookPrincipalFromRawMessage(raw)).toBeNull();
  });
});
