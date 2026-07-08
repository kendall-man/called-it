/**
 * Telegram front door. Webhook-based (register setWebhook manually — see the
 * migration plan). Group gating is eve's default and is exactly the NL-spec
 * addressing spine: commands, @mentions (needs botUsername), and replies to
 * the bot wake it; everything else in a group is ignored.
 *
 * Env: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET_TOKEN,
 *      CONCIERGE_BOT_USERNAME (without the @).
 * BotFather: /setprivacy → Disable (plain @mentions are not delivered to
 * privacy-on bots; eve's own gating does the filtering instead).
 */

import { telegramChannel } from 'eve/channels/telegram';

const botUsername = process.env.CONCIERGE_BOT_USERNAME;

export default telegramChannel({
  // Without a username, group @mention detection is off (commands and
  // replies still work) — set CONCIERGE_BOT_USERNAME in every environment.
  ...(botUsername ? { botUsername } : {}),
});
