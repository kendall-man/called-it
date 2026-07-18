/**
 * Rumble's rich conversational channel — the Vercel Chat SDK over eve.
 *
 * This is NOT the Telegram front door. Telegram talks only to the native
 * channel (telegram.ts); that channel loops conversational private updates
 * back to this channel's route (CHATSDK_TELEGRAM_ROUTE) over internal HTTP.
 * The loopback request is what arms eve's Chat SDK webhook context, so
 * `bridge.send` can start a streaming session from `onDirectMessage`. See
 * runtime/chatsdk-loopback.ts for why the split webhook is required.
 *
 * Streaming is post-then-edit (thread.post → adapter.editMessage) throttled to
 * one edit per second. The bridge registers its own `onAction` for eve HITL
 * cards; identity comes only from the verified webhook principal, never model
 * text (CONTRACTS.md).
 */

import { createMemoryState } from '@chat-adapter/state-memory';
import { createTelegramAdapter } from '@chat-adapter/telegram';
import { chatSdkChannel } from 'eve/channels/chat-sdk';
import { loadConciergeEnv } from '../env.js';
import { telegramWebhookPrincipalFromRawMessage } from '../runtime/chatsdk-auth.js';
import { CHATSDK_TELEGRAM_ROUTE } from '../runtime/chatsdk-loopback.js';

/** Minimum gap between streaming edits (Telegram rate-limit friendly). */
const STREAMING_EDIT_INTERVAL_MS = 1000;

const env = loadConciergeEnv();

const bridge = chatSdkChannel({
  adapters: {
    telegram: createTelegramAdapter({
      botToken: env.TELEGRAM_BOT_TOKEN,
      secretToken: env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
      userName: env.TELEGRAM_BOT_USERNAME,
      // Webhook-only: this adapter is driven exclusively by the loopback POST,
      // so it must never poll or delete the front door's webhook registration.
      mode: 'webhook',
    }),
  },
  state: createMemoryState(),
  streaming: true,
  streamingEditIntervalMs: STREAMING_EDIT_INTERVAL_MS,
  // Non-default route so it cannot collide with the native front door
  // (`/eve/v1/telegram`); reached only via the loopback.
  routes: { telegram: CHATSDK_TELEGRAM_ROUTE },
});

type DirectMessageHandler = Parameters<typeof bridge.bot.onDirectMessage>[0];
type BridgeThread = Parameters<DirectMessageHandler>[0];
type BridgeMessage = Parameters<DirectMessageHandler>[1];

bridge.bot.onDirectMessage(
  async (thread: BridgeThread, message: BridgeMessage): Promise<void> => {
    const auth = telegramWebhookPrincipalFromRawMessage(message.raw);
    // No trusted webhook identity → do not start a session as an unknown actor.
    if (auth === null) return;
    await bridge.send(message.text, { thread, auth });
  },
);

export default bridge.channel;
