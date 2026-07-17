/**
 * Telegram front door — SINGLE-INGRESS mode. This webhook is the only thing
 * Telegram talks to; the engine bot no longer polls (TELEGRAM_INGRESS=webhook
 * over there). Routing:
 *
 *   conversational private chat → looped back to the Chat SDK bridge
 *     (channels/callie.ts, route CHATSDK_TELEGRAM_ROUTE) which starts the rich
 *     streaming Callie session. The loopback is an internal HTTP POST so eve's
 *     Chat SDK webhook context is armed and `bridge.send` works.
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
 * This channel no longer starts native eve sessions: conversational replies
 * stream from the Chat SDK bridge, so onMessage always returns null. Streaming
 * previews (sendMessageDraft) moved to the bridge's post-then-edit path.
 *
 * BotFather: /setprivacy → Disable (the bot must see plain group messages to
 * forward them for claim detection).
 */

import { telegramChannel } from 'eve/channels/telegram';
import { loadConciergeEnv } from '../env.js';
import { forwardTelegramUpdate } from '../lib/engine-api.js';
import {
  CHATSDK_TELEGRAM_ROUTE,
  conciergeDispatchFor,
  conciergeLoopbackOrigin,
  createConciergeLoopback,
} from '../runtime/chatsdk-loopback.js';
import { conciergeLifecycle } from '../runtime/lifecycle.js';
import {
  forwardEngineCallback,
  forwardEngineMessage,
} from '../runtime/telegram-forwarding.js';

const env = loadConciergeEnv();

const conciergeLoopback = createConciergeLoopback({
  origin: conciergeLoopbackOrigin(env.PORT),
  route: CHATSDK_TELEGRAM_ROUTE,
  secretToken: env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
  fetch,
});

export default telegramChannel({
  botUsername: env.TELEGRAM_BOT_USERNAME,
  onMessage: async (_ctx, message) => {
    const destination = await forwardEngineMessage(
      { ...message, raw: message.raw },
      conciergeLifecycle,
      forwardTelegramUpdate,
    );
    if (conciergeDispatchFor(destination) === 'loopback') {
      // Conversational private update: hand it to the Chat SDK bridge so the
      // rich streaming session starts there. Engine and draining destinations
      // were already forwarded/dropped inside forwardEngineMessage.
      await conciergeLoopback.dispatch(message.raw);
    }
    return null; // never start a native session
  },
  onCallbackQuery: async (_ctx, query) => {
    await forwardEngineCallback(
      query.raw,
      conciergeLifecycle,
      forwardTelegramUpdate,
    );
  },
});
