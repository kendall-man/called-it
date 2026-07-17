import type { ConciergeLifecycle } from './lifecycle.js';

export interface TelegramIntakeMessage {
  readonly chat: { readonly type: string };
  readonly text: string;
  readonly caption: string;
  readonly from?: { readonly isBot: boolean };
  readonly isReply?: boolean;
}

export type TelegramIntakeRoute = 'concierge' | 'engine' | 'draining';
export type TelegramEnvelopeRoute = TelegramIntakeRoute | 'ignored';

function isSafePrivateConversation(message: TelegramIntakeMessage): boolean {
  if (message.chat.type !== 'private') return false;
  if (message.from?.isBot !== false) return false;
  if (message.isReply === true) return false;
  if (message.caption.length > 0) return false;
  const text = message.text.trim();
  return text.length > 0 && !text.startsWith('/');
}

export function routeTelegramIntake(
  message: TelegramIntakeMessage,
  lifecycle: ConciergeLifecycle,
): TelegramIntakeRoute {
  if (!lifecycle.acceptsIntake()) return 'draining';
  return isSafePrivateConversation(message) ? 'concierge' : 'engine';
}

export function routeTelegramCallbackIntake(
  lifecycle: ConciergeLifecycle,
): 'engine' | 'draining' {
  return lifecycle.acceptsIntake() ? 'engine' : 'draining';
}

export function routeTelegramEnvelope(
  update: Readonly<Record<string, unknown>>,
  lifecycle: ConciergeLifecycle,
): TelegramEnvelopeRoute {
  if (!lifecycle.acceptsIntake()) return 'draining';
  if (hasOwn(update, 'callback_query') || hasOwn(update, 'my_chat_member')) {
    return 'engine';
  }
  const message = recordField(update, 'message');
  if (message === null) return 'ignored';
  return routeTelegramIntake(messageForIntake(message), lifecycle);
}

function messageForIntake(message: Readonly<Record<string, unknown>>): TelegramIntakeMessage {
  const chat = recordField(message, 'chat');
  const from = recordField(message, 'from');
  const botFlag = from === null ? undefined : booleanField(from, 'is_bot');
  return {
    chat: { type: chat === null ? '' : stringField(chat, 'type') ?? '' },
    text: stringField(message, 'text') ?? '',
    caption: stringField(message, 'caption') ?? '',
    ...(botFlag === undefined ? {} : { from: { isBot: botFlag } }),
    ...(hasOwn(message, 'reply_to_message') ? { isReply: true } : {}),
  };
}

function recordField(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> | null {
  const field = value[key];
  return isRecord(field) ? field : null;
}

function stringField(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

function booleanField(
  value: Readonly<Record<string, unknown>>,
  key: string,
): boolean | undefined {
  const field = value[key];
  return typeof field === 'boolean' ? field : undefined;
}

function hasOwn(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
