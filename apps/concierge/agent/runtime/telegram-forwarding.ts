import type { ConciergeLifecycle } from './lifecycle.js';
import {
  routeTelegramCallbackIntake,
  routeTelegramIntake,
  type TelegramIntakeMessage,
} from './telegram-intake.js';

export type TelegramForwarder = (update: Record<string, unknown>) => Promise<void>;

export interface TelegramForwardingMessage extends TelegramIntakeMessage {
  readonly raw: Record<string, unknown>;
}

let syntheticUpdateId = Math.floor(Date.now() / 1000);

function nextSyntheticUpdateId(): number {
  syntheticUpdateId += 1;
  return syntheticUpdateId;
}

export async function forwardEngineMessage(
  message: TelegramForwardingMessage,
  lifecycle: ConciergeLifecycle,
  forward: TelegramForwarder,
): Promise<'concierge' | 'handled' | 'draining'> {
  const destination = routeTelegramIntake(message, lifecycle);
  if (destination === 'draining') return 'draining';
  if (destination === 'concierge') return 'concierge';
  await forward({ update_id: nextSyntheticUpdateId(), message: message.raw });
  return 'handled';
}

export async function forwardEngineCallback(
  raw: Record<string, unknown>,
  lifecycle: ConciergeLifecycle,
  forward: TelegramForwarder,
): Promise<'handled' | 'draining'> {
  if (routeTelegramCallbackIntake(lifecycle) === 'draining') return 'draining';
  await forward({ update_id: nextSyntheticUpdateId(), callback_query: raw });
  return 'handled';
}
