/**
 * Telegram front door — SINGLE-INGRESS mode. This webhook is the only thing
 * Telegram talks to; the engine bot no longer polls (TELEGRAM_INGRESS=webhook
 * over there). Routing:
 *
 *   safe private free text → the Eve agent (Callie)
 *   every other allowed update → forwarded as its original envelope to the
 *   engine's durable /api/telegram-ingress queue
 *
 * The full-envelope verifier runs before Eve parses the update. Engine-owned
 * envelopes are replaced with an update-id-only body after persistence so
 * neither Eve callbacks nor a conversational session can mutate them.
 *
 * BotFather: /setprivacy → Disable (the bot must see plain group messages to
 * forward them for claim detection).
 */

import { defaultTelegramAuth, telegramChannel } from 'eve/channels/telegram';
import { loadConciergeEnv } from '../env.js';
import { forwardTelegramUpdate } from '../lib/engine-api.js';
import { conciergeLifecycle } from '../runtime/lifecycle.js';
import {
  TELEGRAM_ALLOWED_UPDATES,
  verifyAndRouteTelegramWebhook,
} from '../runtime/telegram-forwarding.js';
import { routeTelegramIntake } from '../runtime/telegram-intake.js';

const env = loadConciergeEnv();

// Keep this deployment registration allowlist in sync with the gate above.
export { TELEGRAM_ALLOWED_UPDATES };

export default telegramChannel({
  botUsername: env.TELEGRAM_BOT_USERNAME,
  credentials: {
    webhookVerifier: (request, body) =>
      verifyAndRouteTelegramWebhook(request, body, {
        lifecycle: conciergeLifecycle,
        secretToken: env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
        forward: forwardTelegramUpdate,
      }),
  },
  onMessage: (_ctx, message) => {
    const route = routeTelegramIntake(
      {
        chat: { type: message.chat.type },
        text: message.text,
        caption: message.caption,
        ...(message.from === undefined ? {} : { from: { isBot: message.from.isBot } }),
        ...(message.replyToMessage === undefined ? {} : { isReply: true }),
      },
      conciergeLifecycle,
    );
    if (route === 'concierge') {
      return { auth: defaultTelegramAuth(message) };
    }
    return null;
  },
  onCallbackQuery: async () => undefined,
});
