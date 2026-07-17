import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { ConciergeLifecycle } from './lifecycle.js';
import {
  routeTelegramEnvelope,
  type TelegramEnvelopeRoute,
} from './telegram-intake.js';

const TelegramEnvelopeSchema = z.object({
  update_id: z.number().int().nonnegative(),
}).passthrough();

export const TELEGRAM_ALLOWED_UPDATES = [
  'message',
  'callback_query',
  'my_chat_member',
] as const;

export type TelegramRawUpdate = z.output<typeof TelegramEnvelopeSchema>;
export type TelegramForwarder = (update: TelegramRawUpdate) => Promise<void>;

export interface TelegramWebhookGateOptions {
  readonly lifecycle: ConciergeLifecycle;
  readonly secretToken: string;
  readonly forward: TelegramForwarder;
}

export async function verifyAndRouteTelegramWebhook(
  request: Request,
  body: string,
  options: TelegramWebhookGateOptions,
): Promise<string | false> {
  const suppliedSecret = request.headers.get('x-telegram-bot-api-secret-token');
  if (suppliedSecret === null || !constantTimeSecretMatch(options.secretToken, suppliedSecret)) {
    return false;
  }

  const parsed = TelegramEnvelopeSchema.safeParse(JSON.parse(body));
  if (!parsed.success) return false;

  const route = await forwardEngineEnvelope(parsed.data, options.lifecycle, options.forward);
  return route === 'concierge' ? body : JSON.stringify({ update_id: parsed.data.update_id });
}

export async function forwardEngineEnvelope(
  update: TelegramRawUpdate,
  lifecycle: ConciergeLifecycle,
  forward: TelegramForwarder,
): Promise<TelegramEnvelopeRoute> {
  const route = routeTelegramEnvelope(update, lifecycle);
  if (route !== 'engine') return route;
  await lifecycle.track(() => forward(update));
  return route;
}

function constantTimeSecretMatch(expected: string, supplied: string): boolean {
  const expectedBytes = Buffer.from(expected, 'utf8');
  const suppliedBytes = Buffer.from(supplied, 'utf8');
  if (expectedBytes.length !== suppliedBytes.length) return false;
  return timingSafeEqual(expectedBytes, suppliedBytes);
}
