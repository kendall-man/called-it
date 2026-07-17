/**
 * Builds the verified `telegram-webhook` principal that `telegramIdentity`
 * (engine-api.ts) reads, from a Chat SDK Telegram message's raw payload.
 *
 * Identity NEVER comes from model output (CONTRACTS.md): it is derived here
 * from the inbound Telegram update, which the webhook secret token has already
 * authenticated. The shape mirrors eve's native `defaultTelegramAuth` so a
 * session started through the Chat SDK bridge resolves identity exactly like a
 * native-channel session — `attributes.chat_id`/`user_id` are strings,
 * `username` is present only when the sender has one.
 */

import type { ChatSdkSendOptions } from 'eve/channels/chat-sdk';

/**
 * The verified caller principal eve stores at `session.auth.current`. Derived
 * from the public `send` options so the concierge never reaches into eve's
 * internal `#channel` types for the `SessionAuthContext` shape.
 */
export type TelegramWebhookPrincipal = NonNullable<ChatSdkSendOptions['auth']>;

/** Trusted Telegram identity carried by a private-chat message. */
export interface TelegramWebhookIdentity {
  readonly chatId: number;
  readonly userId: number;
  readonly username: string | null;
}

const TELEGRAM_WEBHOOK_AUTHENTICATOR = 'telegram-webhook';

/** Builds the `telegram-webhook` principal from a trusted identity. */
export function telegramWebhookPrincipal(
  identity: TelegramWebhookIdentity,
): TelegramWebhookPrincipal {
  const attributes: Record<string, string> = {
    chat_id: String(identity.chatId),
    user_id: String(identity.userId),
  };
  if (identity.username !== null) {
    attributes.username = identity.username;
  }
  return {
    attributes,
    authenticator: TELEGRAM_WEBHOOK_AUTHENTICATOR,
    issuer: 'telegram',
    principalId: `telegram:${identity.userId}`,
    principalType: 'user',
  };
}

/**
 * Narrows a Chat SDK Telegram message's raw payload (the original Bot API
 * `message` object) to the trusted identity fields. Returns null when the
 * chat or sender ids are missing or non-numeric, so a session is never started
 * without a real principal.
 */
export function extractTelegramWebhookIdentity(
  raw: unknown,
): TelegramWebhookIdentity | null {
  if (!isRecord(raw)) return null;
  const chat = isRecord(raw.chat) ? raw.chat : null;
  const from = isRecord(raw.from) ? raw.from : null;
  if (chat === null || from === null) return null;
  const chatId = toFiniteNumber(chat.id);
  const userId = toFiniteNumber(from.id);
  if (chatId === null || userId === null) return null;
  const username = typeof from.username === 'string' ? from.username : null;
  return { chatId, userId, username };
}

/** Convenience: extract identity from a raw message and build its principal. */
export function telegramWebhookPrincipalFromRawMessage(
  raw: unknown,
): TelegramWebhookPrincipal | null {
  const identity = extractTelegramWebhookIdentity(raw);
  return identity === null ? null : telegramWebhookPrincipal(identity);
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
