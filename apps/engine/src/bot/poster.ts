/**
 * Fire-and-forget chat output funneled through the per-chat send queue.
 * Non-bot modules (settler, cron) talk to Telegram exclusively through this.
 */

import type { Api } from 'grammy';
import type { InlineKeyboard } from 'grammy';
import type { Logger } from '../log.js';
import type { SendQueue } from './sendQueue.js';

export interface PostOptions {
  replyToMessageId?: number;
  keyboard?: InlineKeyboard;
  /** Runs after a successful send (e.g. mark a settlement posted). */
  onSent?: (messageId: number) => Promise<void>;
}

export interface Poster {
  post(chatId: number, text: string, options?: PostOptions): void;
  editCard(chatId: number, marketId: string, messageId: number, text: string, keyboard?: InlineKeyboard): void;
}

export function createPoster(api: Api, queue: SendQueue, log: Logger): Poster {
  return {
    post(chatId, text, options = {}) {
      queue.enqueue(chatId, async () => {
        const message = await api.sendMessage(chatId, text, {
          ...(options.replyToMessageId !== undefined
            ? { reply_parameters: { message_id: options.replyToMessageId } }
            : {}),
          ...(options.keyboard ? { reply_markup: options.keyboard } : {}),
          link_preview_options: { is_disabled: true },
        });
        if (options.onSent) await options.onSent(message.message_id);
      });
    },
    editCard(chatId, marketId, messageId, text, keyboard) {
      queue.enqueueCardEdit(chatId, marketId, async () => {
        try {
          await api.editMessageText(chatId, messageId, text, {
            ...(keyboard ? { reply_markup: keyboard } : {}),
            link_preview_options: { is_disabled: true },
          });
        } catch (err) {
          // "message is not modified" is routine when a collapse squashed
          // an intermediate state — anything else is worth a log line.
          const detail = String(err);
          if (!detail.includes('message is not modified')) {
            log.warn('card_edit_failed', { chatId, marketId, error: detail });
          }
        }
      });
    },
  };
}
