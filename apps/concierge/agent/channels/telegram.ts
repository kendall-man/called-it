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
 * While Callie generates a private-chat reply, message.appended deltas stream
 * as native Telegram drafts (sendMessageDraft, throttled per chat). Drafts are
 * ephemeral previews: the default message.completed send stays authoritative,
 * and any draft failure permanently falls back to it for this process.
 *
 * BotFather: /setprivacy → Disable (the bot must see plain group messages to
 * forward them for claim detection).
 */

import {
  defaultTelegramAuth,
  telegramChannel,
  type TelegramEventContext,
} from 'eve/channels/telegram';
import { loadConciergeEnv } from '../env.js';
import { forwardTelegramUpdate } from '../lib/engine-api.js';
import {
  draftChatId,
  isPrivateDraftTarget,
  telegramDraftPlanner,
} from '../runtime/draft-stream.js';
import { conciergeLifecycle } from '../runtime/lifecycle.js';
import {
  forwardEngineCallback,
  forwardEngineMessage,
} from '../runtime/telegram-forwarding.js';

const botUsername = loadConciergeEnv().TELEGRAM_BOT_USERNAME;

function logDraftStreamDisabled(reason: string): void {
  process.stderr.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      event: 'telegram_draft_stream_disabled',
      reason,
    })}\n`,
  );
}

async function streamReplyDraft(
  channel: TelegramEventContext,
  data: { readonly messageSoFar: string; readonly turnId: string },
): Promise<void> {
  try {
    const { telegram, state } = channel;
    if (!isPrivateDraftTarget(telegram.chatType ?? state.chatType)) return;
    const send = telegramDraftPlanner.plan(
      telegram.chatId,
      data.turnId,
      data.messageSoFar,
      Date.now(),
    );
    if (send === null) return;
    const response = await telegram.request('sendMessageDraft', {
      chat_id: draftChatId(telegram.chatId),
      draft_id: send.draftId,
      text: send.text,
    });
    if (!response.ok) {
      throw new Error(`sendMessageDraft_status_${response.status}`);
    }
  } catch (error) {
    // Drafts are a cosmetic preview: any failure (e.g. the method missing on
    // this Bot API server) disables streaming for the process lifetime, and
    // the default message.completed send still delivers the reply.
    if (telegramDraftPlanner.disable()) {
      logDraftStreamDisabled(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

export default telegramChannel({
  botUsername,
  events: {
    // Streams the in-progress private-chat reply as a native Telegram draft.
    // Handlers merge over the channel defaults, so the final
    // message.completed sendMessage (the source of truth) is untouched.
    'message.appended': async (data, channel) => {
      await streamReplyDraft(channel, data);
    },
    'turn.completed': (_data, channel) => {
      telegramDraftPlanner.complete(channel.telegram.chatId);
    },
  },
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
