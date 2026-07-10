import type { ConciergeLifecycle } from './lifecycle.js';

export interface TelegramIntakeMessage {
  readonly chat: { readonly type: string };
  readonly text: string;
  readonly caption: string;
  readonly from?: { readonly isBot: boolean };
}

export type TelegramIntakeRoute = 'concierge' | 'engine' | 'draining';

function isConversational(message: TelegramIntakeMessage, botUsername: string): boolean {
  if (message.from?.isBot) return false;
  const text = `${message.text} ${message.caption}`.trim();
  if (text.startsWith('/')) return false;
  if (message.chat.type === 'private') return true;
  if (botUsername === '') return false;
  return text.toLowerCase().includes(`@${botUsername.toLowerCase()}`);
}

export function routeTelegramIntake(
  message: TelegramIntakeMessage,
  botUsername: string,
  lifecycle: ConciergeLifecycle,
): TelegramIntakeRoute {
  if (!lifecycle.acceptsIntake()) return 'draining';
  return isConversational(message, botUsername) ? 'concierge' : 'engine';
}
