/**
 * Commands: private navigation plus group calls and board access. An author
 * can make an explicit call; a friend-triggered call waits for author consent.
 */

import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { EngineDb } from '../ports.js';
import type { Env } from '../env.js';
import type { Poster } from './poster.js';
import { ensureChatContext, ensureUserSeen, isGroupAdmin, type HandlerCtx } from './context.js';
import { settingsKeyboard } from './keyboards.js';
import { offerClaim } from '../pipeline/offer.js';
import type { Say } from './copy.js';
import {
  groupBoardUrl,
  groupReadyMarkerStore,
  groupInstallUrl,
  planGroupReadiness,
} from './onboarding.js';
import { isBetaGroupAllowed } from './beta-access.js';

function isGroup(chatType: string): boolean {
  return chatType === 'group' || chatType === 'supergroup';
}

export function bookitConsent(
  senderUserId: number,
  targetAuthorUserId: number,
): 'explicit' | 'awaiting_confirm' {
  return senderUserId === targetAuthorUserId ? 'explicit' : 'awaiting_confirm';
}

export interface NavigationCommandContext {
  readonly chat: { readonly id: number; readonly type: string; readonly title?: string };
  readonly me: { readonly username: string };
}

export interface NavigationCommandBot {
  command(name: string, handler: (ctx: NavigationCommandContext) => Promise<unknown>): void;
}

export interface NavigationHandlerCtx {
  readonly deps: {
    readonly db: Pick<EngineDb, 'upsertGroup' | 'markGroupReady'>;
    readonly env: Pick<Env, 'WEB_BASE_URL' | 'DEPLOYMENT_ENV' | 'BETA_ALLOWED_GROUP_IDS'>;
  };
  readonly poster: Pick<Poster, 'post'>;
  readonly say: Say;
}

function installKeyboard(botUsername: string): InlineKeyboard {
  return new InlineKeyboard().url('Add to group', groupInstallUrl(botUsername));
}

function boardKeyboard(boardUrl: string): InlineKeyboard {
  return new InlineKeyboard().url('Open group board', boardUrl);
}

export function registerNavigationCommands(bot: NavigationCommandBot, h: NavigationHandlerCtx): void {
  bot.command('start', async (ctx) => {
    if (!isGroup(ctx.chat.type)) {
      h.poster.post(ctx.chat.id, await h.say('private_start'), {
        keyboard: installKeyboard(ctx.me.username),
      });
      return;
    }
    if (!isBetaGroupAllowed(h.deps.env, ctx.chat.id)) return;
    const group = await h.deps.db.upsertGroup({ id: ctx.chat.id, title: ctx.chat.title ?? '' });
    const plan = await planGroupReadiness({
      store: groupReadyMarkerStore(h.deps.db),
      group,
      webBaseUrl: h.deps.env.WEB_BASE_URL,
    });
    if (plan.kind === 'post_ready') h.poster.post(ctx.chat.id, plan.text);
  });

  bot.command('help', async (ctx) => {
    const line = await h.say('help');
    h.poster.post(ctx.chat.id, line);
  });

  bot.command('table', async (ctx) => {
    if (!isGroup(ctx.chat.type)) {
      h.poster.post(ctx.chat.id, await h.say('group_only_recovery'));
      return;
    }
    if (!isBetaGroupAllowed(h.deps.env, ctx.chat.id)) return;
    const group = await h.deps.db.upsertGroup({ id: ctx.chat.id, title: ctx.chat.title ?? '' });
    const boardUrl = groupBoardUrl(h.deps.env.WEB_BASE_URL, group.slug);
    h.poster.post(ctx.chat.id, await h.say('table_link'), { keyboard: boardKeyboard(boardUrl) });
  });
}

export function registerCommands(bot: Bot, h: HandlerCtx): void {
  registerNavigationCommands(bot, h);

  bot.command('settings', async (ctx) => {
    if (!isGroup(ctx.chat.type) || !ctx.from) return;
    if (!isBetaGroupAllowed(h.deps.env, ctx.chat.id)) return;
    const from = ctx.from;
    const group = await ensureChatContext(h, ctx.chat.id, ctx.chat.title ?? '', from);
    const admin = await isGroupAdmin(h, () => ctx.getChatMember(from.id));
    if (!admin) {
      h.poster.post(ctx.chat.id, await h.say('admin_only'), {
        replyToMessageId: ctx.message?.message_id,
      });
      return;
    }
    h.poster.post(ctx.chat.id, await h.say('settings_intro'), {
      keyboard: settingsKeyboard(group.chattiness, group.web_enabled),
    });
  });

  bot.command('bookit', async (ctx) => {
    if (!isGroup(ctx.chat.type)) {
      h.poster.post(ctx.chat.id, await h.say('group_only_recovery'));
      return;
    }
    if (!ctx.from) return;
    if (!isBetaGroupAllowed(h.deps.env, ctx.chat.id)) return;
    const group = await ensureChatContext(h, ctx.chat.id, ctx.chat.title ?? '', ctx.from);
    const target = ctx.message?.reply_to_message;
    if (!target?.text || !target.from || target.from.is_bot) {
      h.poster.post(ctx.chat.id, await h.say('bookit_needs_reply'), {
        replyToMessageId: ctx.message?.message_id,
      });
      return;
    }
    await ensureUserSeen(h, ctx.chat.id, target.from);
    await offerClaim(h, {
      chatId: ctx.chat.id,
      group,
      text: target.text,
      claimer: target.from,
      sourceMessageId: target.message_id,
      confidence: null,
      announce: true,
      consent: bookitConsent(ctx.from.id, target.from.id),
    });
  });

}
