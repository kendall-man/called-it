import type { ConciergeLifecycle } from './lifecycle.js';

export interface TelegramIntakeMessage {
  readonly chat: { readonly type: string };
  readonly text: string;
  readonly caption: string;
  readonly from?: { readonly isBot: boolean };
}

export type TelegramIntakeRoute = 'concierge' | 'engine' | 'draining';

function isConversational(message: TelegramIntakeMessage): boolean {
  if (message.from?.isBot) return false;
  const text = `${message.text} ${message.caption}`.trim();
  if (text.startsWith('/')) return false;
  return message.chat.type === 'private';
}

export function routeTelegramIntake(
  message: TelegramIntakeMessage,
  lifecycle: ConciergeLifecycle,
): TelegramIntakeRoute {
  if (!lifecycle.acceptsIntake()) return 'draining';
  return isConversational(message) ? 'concierge' : 'engine';
}

export function routeTelegramCallbackIntake(
  lifecycle: ConciergeLifecycle,
): 'engine' | 'draining' {
  return lifecycle.acceptsIntake() ? 'engine' : 'draining';
}
