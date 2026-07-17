/**
 * Fire-and-forget chat output funneled through the per-chat send queue.
 * Non-bot modules (settler, cron) talk to Telegram exclusively through this.
 */

import type { Api } from 'grammy';
import type { InlineKeyboard } from 'grammy';
import type { ReactionTypeEmoji } from 'grammy/types';
import type { Logger } from '../log.js';
import type { SendQueue } from './sendQueue.js';

/** Telegram's fixed reaction set — anything outside this union is rejected by the API. */
export type ReactionEmoji = ReactionTypeEmoji['emoji'];

export type ChatAction = Parameters<Api['sendChatAction']>[1];

export interface PostOptions {
  replyToMessageId?: number;
  keyboard?: InlineKeyboard;
  /** Runs after a successful send (e.g. mark a settlement posted). */
  onSent?: (messageId: number) => Promise<void>;
  /** Runs when the send itself fails, so callers can fall back (send queue has no retry). */
  onSendFailed?: () => void;
}

export interface Poster {
  post(chatId: number, text: string, options?: PostOptions): void;
  editCard(chatId: number, marketId: string, messageId: number, text: string, keyboard?: InlineKeyboard): void;
  /** Best-effort removal of an inline keyboard from an earlier message. */
  stripKeyboard(chatId: number, messageId: number): void;
  /**
   * Best-effort emoji reaction on an existing message. Fire-and-forget and
   * queue-free: reactions do not count against the per-chat message budget,
   * so they may fire in every chattiness mode. A rejection is swallowed.
   */
  react(chatId: number, messageId: number, emoji: ReactionEmoji): void;
  /**
   * Best-effort chat action ("typing…" presence). Fire-and-forget and
   * queue-free like react; Telegram clears the status after ~5s, so callers
   * re-fire during long waits.
   */
  chatAction(chatId: number, action: ChatAction): void;
}

export function createPoster(api: Api, queue: SendQueue, log: Logger): Poster {
  return {
    post(chatId, text, options = {}) {
      queue.enqueue(chatId, async () => {
        try {
          const message = await api.sendMessage(chatId, text, {
            ...(options.replyToMessageId !== undefined
              ? {
                  // allow_sending_without_reply: the claim/source message can be
                  // deleted between detection and this send (e.g. a user removes
                  // their banter while the parse runs). Without this the whole
                  // offer card send fails and the market silently has no card.
                  reply_parameters: {
                    message_id: options.replyToMessageId,
                    allow_sending_without_reply: true,
                  },
                }
              : {}),
            ...(options.keyboard ? { reply_markup: options.keyboard } : {}),
            link_preview_options: { is_disabled: true },
          });
          if (options.onSent) await options.onSent(message.message_id);
        } catch (err) {
          options.onSendFailed?.();
          throw err; // rethrow so the queue's onError still logs the failure
        }
      });
    },
    react(chatId, messageId, emoji) {
      void api
        .setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji }])
        .catch(() => {
          // Deleted message, reactions disabled, etc. — presence only, move on.
          log.warn('reaction_failed');
        });
    },
    chatAction(chatId, action) {
      void api.sendChatAction(chatId, action).catch(() => {
        log.warn('chat_action_failed');
      });
    },
    stripKeyboard(chatId, messageId) {
      queue.enqueue(chatId, async () => {
        try {
          await api.editMessageReplyMarkup(chatId, messageId);
        } catch (err) {
          // The message may be old or already keyboard-less — log the rest.
          const detail = String(err);
          if (!detail.includes('message is not modified')) {
            log.warn('strip_keyboard_failed');
          }
        }
      });
    },
    editCard(chatId, marketId, messageId, text, keyboard) {
      queue.enqueueCardEdit(chatId, marketId, async () => {
        try {
          await api.editMessageText(chatId, messageId, text, {
            // Telegram preserves the old inline keyboard when reply_markup is
            // omitted. An explicit empty keyboard removes stale money actions.
            reply_markup: keyboard ?? { inline_keyboard: [] },
            link_preview_options: { is_disabled: true },
          });
        } catch (err) {
          // "message is not modified" is routine when a collapse squashed
          // an intermediate state — anything else is worth a log line.
          const detail = String(err);
          if (!detail.includes('message is not modified')) {
            log.warn('card_edit_failed', { marketId });
          }
        }
      });
    },
  };
}
