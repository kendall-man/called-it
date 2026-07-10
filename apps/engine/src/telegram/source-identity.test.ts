import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TEST_ENV } from '../api/server-test-env.js';
import { deriveTelegramSourceIdentity } from './source-identity.js';

describe('deriveTelegramSourceIdentity', () => {
  it('derives exact message, callback, member, and fallback keys', () => {
    expect(
      deriveTelegramSourceIdentity(
        {
          update_id: 41,
          message: { message_id: 7, chat: { id: -1001 }, text: 'hi' },
        },
        TEST_ENV.ANALYTICS_HMAC_SECRET,
      ).sourceKey,
    ).toBe('msg:-1001:7');
    expect(
      deriveTelegramSourceIdentity(
        {
          update_id: 42,
          callback_query: { id: 'callback-1', message: { message_id: 7, chat: { id: -1001 } } },
        },
        TEST_ENV.ANALYTICS_HMAC_SECRET,
      ).sourceKey,
    ).toBe('cb:callback-1');
    expect(
      deriveTelegramSourceIdentity(
        {
          update_id: 43,
          my_chat_member: { chat: { id: -1001 }, new_chat_member: { status: 'member' } },
        },
        TEST_ENV.ANALYTICS_HMAC_SECRET,
      ).sourceKey,
    ).toBe('member:-1001:43');
    expect(
      deriveTelegramSourceIdentity(
        {
          update_id: 44,
          edited_message: { message_id: 8, chat: { id: -1001 }, text: 'patched' },
        },
        TEST_ENV.ANALYTICS_HMAC_SECRET,
      ).sourceKey,
    ).toBe('upd:44:edited_message');
  });

  it('keeps the fingerprint stable for the same input and changes it on namespace changes', () => {
    const first = deriveTelegramSourceIdentity(
      { update_id: 50, message: { message_id: 9, chat: { id: -1002 }, text: 'hello' } },
      TEST_ENV.ANALYTICS_HMAC_SECRET,
    );
    const second = deriveTelegramSourceIdentity(
      { update_id: 50, message: { message_id: 9, chat: { id: -1002 }, text: 'hello' } },
      TEST_ENV.ANALYTICS_HMAC_SECRET,
    );
    const changed = deriveTelegramSourceIdentity(
      { update_id: 50, message: { message_id: 10, chat: { id: -1002 }, text: 'hello' } },
      TEST_ENV.ANALYTICS_HMAC_SECRET,
    );
    expect(first.sourceFingerprint).toBe(second.sourceFingerprint);
    expect(first.sourceFingerprint).not.toBe(changed.sourceFingerprint);
    expect(first.sourceFingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.sourceFingerprint).toBe(
      createHmac('sha256', Buffer.from(TEST_ENV.ANALYTICS_HMAC_SECRET, 'base64'))
        .update(Buffer.from('telegram-source', 'utf8'))
        .update(Buffer.from('msg:-1002:9', 'utf8'))
        .digest('base64url'),
    );
  });
});
