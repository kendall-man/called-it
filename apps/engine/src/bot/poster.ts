/**
 * Fire-and-forget chat output funneled through the per-chat send queue.
 * Non-bot modules (settler, cron) talk to Telegram exclusively through this.
 */

import type { Api } from 'grammy';
import type { InlineKeyboard } from 'grammy';
import type { Logger } from '../log.js';
import type { OwnedTelegramSender } from '../telegram/owned-sender.js';
import type { OwnedTelegramSendResult } from '../telegram/owned-sender-contract.js';
import type { SendQueue } from './sendQueue.js';

export interface PostOptions {
  replyToMessageId?: number;
  keyboard?: InlineKeyboard;
  /** Runs after a successful send (e.g. mark a settlement posted). */
  onSent?: (messageId: number) => Promise<void>;
}

export interface OwnedPostOptions {
  readonly logicalKey: string;
  readonly domainKind: string;
  readonly domainId: string;
  readonly replyToMessageId?: number;
  readonly keyboard?: InlineKeyboard;
  readonly recordAuthoritativeMessageId?: (messageId: number) => Promise<void>;
}

export interface Poster {
  post(chatId: number, text: string, options?: PostOptions): void;
  editCard(chatId: number, marketId: string, messageId: number, text: string, keyboard?: InlineKeyboard): void;
  /** Best-effort removal of an inline keyboard from an earlier message. */
  stripKeyboard(chatId: number, messageId: number): void;
}

export interface OwnedPoster extends Poster {
  /** Sends through durable ownership; an `owned` outcome has committed the Telegram message id. */
  postOwned(
    chatId: number,
    text: string,
    options: OwnedPostOptions,
  ): Promise<OwnedTelegramSendResult>;
  configureOutboundOwnership(sender: OwnedTelegramSender): void;
}

export function createPoster(api: Api, queue: SendQueue, log: Logger): OwnedPoster {
  let outboundOwnership: OwnedTelegramSender | null = null;

  const sendMessage = async (
    chatId: number,
    text: string,
    options: Pick<PostOptions, 'replyToMessageId' | 'keyboard'>,
  ) => api.sendMessage(chatId, text, {
    ...(options.replyToMessageId !== undefined
      ? { reply_parameters: { message_id: options.replyToMessageId } }
      : {}),
    ...(options.keyboard ? { reply_markup: options.keyboard } : {}),
    link_preview_options: { is_disabled: true },
  });

  return {
    configureOutboundOwnership(sender) {
      outboundOwnership = sender;
    },
    post(chatId, text, options = {}) {
      queue.enqueue(chatId, async () => {
        const message = await sendMessage(chatId, text, options);
        if (options.onSent) await options.onSent(message.message_id);
      });
    },
    async postOwned(chatId, text, options) {
      if (outboundOwnership === null) {
        return {
          kind: 'skipped',
          jobId: null,
          state: null,
          code: 'outbound_ownership_unconfigured',
        };
      }
      return outboundOwnership.send({
        logicalKey: options.logicalKey,
        chatId,
        domainKind: options.domainKind,
        domainId: options.domainId,
        send: async () => {
          const message = await queue.enqueueAndWait(chatId, () => sendMessage(chatId, text, options));
          return message.message_id;
        },
        ...(options.recordAuthoritativeMessageId === undefined
          ? {}
          : { recordAuthoritativeMessageId: options.recordAuthoritativeMessageId }),
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
            log.warn('strip_keyboard_failed', { chatId, messageId, error: detail });
          }
        }
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
