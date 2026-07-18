/**
 * Bot API 10.2 ephemeral group messages (verified against the method reference
 * at https://core.telegram.org/bots/api, "sendMessage" / "editEphemeralMessageText"
 * sections, 2026-07-14 update).
 *
 * An ephemeral message is a group message visible ONLY to a single member. The
 * per-user stake stepper (STAKE_LADDER_ENABLED) lives in one of these so the
 * SHARED market card can keep its two side buttons for everyone else — a member
 * sizing a stake never takes the shared surface hostage.
 *
 * grammY 1.44 does not type these methods, so this is a tiny raw client over the
 * Bot API HTTP endpoint. Two calls are used:
 *   - sendMessage with `receiver_user_id` + `callback_query_id`: sends the
 *     ephemeral within 15s of the member's tap WITHOUT the bot needing admin.
 *     The returned Message carries `ephemeral_message_id`.
 *   - editEphemeralMessageText with `user_id` + `ephemeral_message_id`: edits the
 *     per-user ephemeral in place as the member steps the amount.
 *
 * Everything here is best-effort: a network throw or an `ok:false` response is
 * swallowed (logged once) and reported to the caller, which degrades to the
 * per-user signing fallback rather than ever touching the shared card. This
 * surface is per-user and transient (like reactions), so it deliberately does
 * not go through the per-chat send queue.
 */

import type { InlineKeyboard } from 'grammy';
import type { Logger } from '../log.js';

export interface EphemeralSendInput {
  readonly chatId: number;
  /** The member who alone should see the ephemeral (the tapper). */
  readonly receiverUserId: number;
  /** The tap's callback_query id — the 15s no-admin send authorization. */
  readonly callbackQueryId: string;
  readonly text: string;
  readonly replyMarkup?: InlineKeyboard;
}

export type EphemeralSendResult =
  | { readonly ok: true; readonly ephemeralMessageId: number }
  | { readonly ok: false };

export interface EphemeralEditInput {
  readonly userId: number;
  readonly ephemeralMessageId: number;
  readonly text: string;
  readonly replyMarkup?: InlineKeyboard;
}

/**
 * Best-effort per-user ephemeral message surface. Never throws: a failure to
 * send or edit is reported so the caller can degrade to a per-user signing
 * fallback. The shared card is never edited from here.
 */
export interface EphemeralPort {
  send(input: EphemeralSendInput): Promise<EphemeralSendResult>;
  /** True when the in-place edit landed; false degrades to a re-send. */
  edit(input: EphemeralEditInput): Promise<boolean>;
}

interface BotApiResponse {
  readonly ok?: boolean;
  readonly result?: { readonly ephemeral_message_id?: number };
}

function replyMarkupPayload(keyboard: InlineKeyboard | undefined): { inline_keyboard: unknown[] } {
  // grammY's InlineKeyboard serializes to { inline_keyboard: [...] }; an absent
  // keyboard becomes an explicit empty one so an edit clears stale buttons.
  return { inline_keyboard: keyboard?.inline_keyboard ?? [] };
}

/**
 * The live Telegram ephemeral client. `fetchImpl` is injectable for tests; the
 * default is the global fetch. `token` is the BotFather token (never logged).
 */
export function createTelegramEphemeralPort(options: {
  readonly token: string;
  readonly log: Logger;
  readonly fetchImpl?: typeof fetch;
}): EphemeralPort {
  const doFetch = options.fetchImpl ?? fetch;
  const endpoint = (method: string): string =>
    `https://api.telegram.org/bot${options.token}/${method}`;

  async function callApi(method: string, body: Record<string, unknown>): Promise<BotApiResponse | null> {
    try {
      const response = await doFetch(endpoint(method), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await response.json()) as BotApiResponse;
      if (json.ok !== true) {
        options.log.warn('ephemeral_api_not_ok', { method });
        return null;
      }
      return json;
    } catch {
      options.log.warn('ephemeral_api_failed', { method });
      return null;
    }
  }

  return {
    async send(input) {
      const json = await callApi('sendMessage', {
        chat_id: input.chatId,
        text: input.text,
        receiver_user_id: input.receiverUserId,
        callback_query_id: input.callbackQueryId,
        link_preview_options: { is_disabled: true },
        ...(input.replyMarkup === undefined ? {} : { reply_markup: replyMarkupPayload(input.replyMarkup) }),
      });
      const ephemeralMessageId = json?.result?.ephemeral_message_id;
      if (typeof ephemeralMessageId !== 'number') return { ok: false };
      return { ok: true, ephemeralMessageId };
    },
    async edit(input) {
      const json = await callApi('editEphemeralMessageText', {
        user_id: input.userId,
        ephemeral_message_id: input.ephemeralMessageId,
        text: input.text,
        link_preview_options: { is_disabled: true },
        reply_markup: replyMarkupPayload(input.replyMarkup),
      });
      return json !== null;
    },
  };
}
