/**
 * Telegram front door — SINGLE-INGRESS mode. This webhook is the only thing
 * Telegram talks to; the engine bot no longer polls (TELEGRAM_INGRESS=webhook
 * over there). Routing:
 *
 *   conversational private chat → the eve agent (Callie)
 *   every group message, including explicit @mentions, plus /commands and
 *   card-button callback queries
 *     → forwarded verbatim to the engine's /api/telegram-ingress, where the
 *       existing grammY handlers process it exactly as if polled
 *
 * eve answers its own HITL callbacks (approval keyboards) before
 * onCallbackQuery fires, so only the engine's pv:/st:/cf: buttons reach the
 * forwarder. Until the semantic prefilter ships, all group messages stay on
 * the engine path; Eve conversational intake is private-chat only.
 *
 * BotFather: /setprivacy → Disable (the bot must see plain group messages to
 * forward them for claim detection).
 */

import { defaultTelegramAuth, telegramChannel } from 'eve/channels/telegram';
import { loadConciergeEnv } from '../env.js';
import { forwardTelegramUpdate } from '../lib/engine-api.js';
import { conciergeLifecycle } from '../runtime/lifecycle.js';
import {
  forwardEngineCallback,
  forwardEngineMessage,
} from '../runtime/telegram-forwarding.js';

const botUsername = loadConciergeEnv().TELEGRAM_BOT_USERNAME;

export default telegramChannel({
  botUsername,
  onMessage: async (_ctx, message) => {
    const destination = await forwardEngineMessage(
      { ...message, raw: message.raw },
      conciergeLifecycle,
      forwardTelegramUpdate,
    );
    if (destination === 'draining') return null;
    if (destination === 'concierge') {
      return { auth: defaultTelegramAuth(message) };
    }
    return null; // handled — do not start an agent session
  },
  onCallbackQuery: async (_ctx, query) => {
    await forwardEngineCallback(
      query.raw,
      conciergeLifecycle,
      forwardTelegramUpdate,
    );
  },
});
