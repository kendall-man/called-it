/**
 * Telegram front door — SINGLE-INGRESS mode. This webhook is the only thing
 * Telegram talks to; the engine bot no longer polls (TELEGRAM_INGRESS=webhook
 * over there). Routing:
 *
 *   conversational (private chat, or a group @mention that isn't a command)
 *     → the eve agent (Callie)
 *   everything else (plain group chatter for claim detection, /commands,
 *   card-button callback queries)
 *     → forwarded verbatim to the engine's /api/telegram-update, where the
 *       existing grammY handlers process it exactly as if polled
 *
 * eve answers its own HITL callbacks (approval keyboards) before
 * onCallbackQuery fires, so only the engine's pv:/st:/cf: buttons reach the
 * forwarder. Replies to bot messages go to the engine (cards); to keep a
 * conversation with Callie going, @mention her again — instructions tell her
 * to always offer options (inline keyboard) instead of freeform follow-ups.
 *
 * BotFather: /setprivacy → Disable (the bot must see plain group messages to
 * forward them for claim detection).
 */

import { defaultTelegramAuth, telegramChannel } from 'eve/channels/telegram';
import { loadConciergeEnv } from '../env.js';
import { forwardTelegramUpdate } from '../lib/engine-api.js';

const botUsername = loadConciergeEnv().TELEGRAM_BOT_USERNAME;

/** Synthetic envelope id — grammY only uses update_id for polling offsets. */
let syntheticUpdateId = Math.floor(Date.now() / 1000);

function isConversational(message: {
  chat: { type: string };
  text: string;
  caption: string;
  from?: { isBot: boolean };
}): boolean {
  if (message.from?.isBot) return false;
  const text = `${message.text} ${message.caption}`.trim();
  if (text.startsWith('/')) return false; // commands are the engine's surface
  if (message.chat.type === 'private') return true;
  if (!botUsername) return false;
  return text.toLowerCase().includes(`@${botUsername.toLowerCase()}`);
}

export default telegramChannel({
  botUsername,
  onMessage: async (_ctx, message) => {
    if (isConversational(message)) {
      return { auth: defaultTelegramAuth(message) };
    }
    syntheticUpdateId += 1;
    await forwardTelegramUpdate({ update_id: syntheticUpdateId, message: message.raw }).catch(
      (err) => console.error('[ingress] forward message failed:', String(err)),
    );
    return null; // handled — do not start an agent session
  },
  onCallbackQuery: async (_ctx, query) => {
    // eve already consumed its own HITL callbacks; these are the engine's.
    syntheticUpdateId += 1;
    await forwardTelegramUpdate({ update_id: syntheticUpdateId, callback_query: query.raw }).catch(
      (err) => console.error('[ingress] forward callback failed:', String(err)),
    );
  },
});
