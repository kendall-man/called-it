/**
 * Commands: private navigation plus group calls and board access. An author
 * can make an explicit call; a friend-triggered call waits for author consent.
 */

import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { User } from 'grammy/types';
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
import {
  leaderboardText,
  personalStatsText,
  TELEGRAM_MESSAGE_LIMIT,
} from '../points/presentation.js';

const GROUP_LEADERBOARD_LIMIT = 10;
const GROUP_RANK_LIMIT = 100;

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
  readonly from?: User | undefined;
}

export interface NavigationCommandBot {
  command(name: string, handler: (ctx: NavigationCommandContext) => Promise<unknown>): void;
}

export interface NavigationHandlerCtx {
  readonly deps: {
    readonly db: Pick<
      EngineDb,
      'upsertGroup' | 'markGroupReady' | 'leaderboard' | 'groupPlayerStats'
    >;
    readonly env: Pick<Env, 'WEB_BASE_URL' | 'DEPLOYMENT_ENV' | 'BETA_ALLOWED_GROUP_IDS'>;
  };
  readonly poster: Pick<Poster, 'post'>;
  readonly say: Say;
  readonly refreshMember: (input: {
    readonly chatId: number;
    readonly chatTitle: string;
    readonly user: User;
  }) => Promise<void>;
}

function installKeyboard(botUsername: string): InlineKeyboard {
  return new InlineKeyboard().url('Add to group', groupInstallUrl(botUsername));
}

function boardKeyboard(boardUrl: string): InlineKeyboard {
  return new InlineKeyboard().url('Open group board', boardUrl);
}

async function acceptsGroupCommand(
  ctx: NavigationCommandContext,
  h: NavigationHandlerCtx,
): Promise<boolean> {
  if (!isGroup(ctx.chat.type)) {
    h.poster.post(ctx.chat.id, await h.say('group_only_recovery'));
    return false;
  }
  return isBetaGroupAllowed(h.deps.env, ctx.chat.id);
}

async function topTenText(h: NavigationHandlerCtx, groupId: number): Promise<string> {
  const entries = await h.deps.db.leaderboard(groupId, GROUP_LEADERBOARD_LIMIT);
  return leaderboardText(
    {
      entries: entries.map((entry) => ({
        username: entry.username,
        displayName: entry.display_name,
        points: entry.points,
        wins: entry.wins,
        losses: entry.losses,
      })),
      limit: GROUP_LEADERBOARD_LIMIT,
    },
    TELEGRAM_MESSAGE_LIMIT,
  );
}

function isValidSender(user: User | undefined): user is User {
  return user !== undefined && !user.is_bot && Number.isSafeInteger(user.id) && user.id > 0;
}

async function runPointsCommand(
  ctx: NavigationCommandContext,
  h: NavigationHandlerCtx,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch {
    h.poster.post(ctx.chat.id, await h.say('points_unavailable'));
  }
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
    if (!(await acceptsGroupCommand(ctx, h))) return;
    await runPointsCommand(ctx, h, async () => {
      const group = await h.deps.db.upsertGroup({ id: ctx.chat.id, title: ctx.chat.title ?? '' });
      const boardUrl = groupBoardUrl(h.deps.env.WEB_BASE_URL, group.slug);
      h.poster.post(ctx.chat.id, await topTenText(h, ctx.chat.id), {
        keyboard: boardKeyboard(boardUrl),
      });
    });
  });

  bot.command('leaderboard', async (ctx) => {
    if (!(await acceptsGroupCommand(ctx, h))) return;
    await runPointsCommand(ctx, h, async () => {
      await h.deps.db.upsertGroup({ id: ctx.chat.id, title: ctx.chat.title ?? '' });
      h.poster.post(ctx.chat.id, await topTenText(h, ctx.chat.id));
    });
  });

  bot.command('mystats', async (ctx) => {
    if (!(await acceptsGroupCommand(ctx, h))) return;
    const sender = ctx.from;
    if (!isValidSender(sender)) return;
    await runPointsCommand(ctx, h, async () => {
      await h.refreshMember({
        chatId: ctx.chat.id,
        chatTitle: ctx.chat.title ?? '',
        user: sender,
      });
      const stats = await h.deps.db.groupPlayerStats(ctx.chat.id, sender.id);
      const board = await h.deps.db.leaderboard(ctx.chat.id, GROUP_RANK_LIMIT);
      const rankIndex = board.findIndex((entry) => entry.user_id === sender.id);
      h.poster.post(
        ctx.chat.id,
        personalStatsText(
          {
            rank: rankIndex !== -1
              ? rankIndex + 1
              : stats.wins > 0 || stats.losses > 0
                ? 'outside_top_100'
                : null,
            points: stats.points,
            wins: stats.wins,
            losses: stats.losses,
            currentStreak: stats.current_streak,
            bestStreak: stats.best_streak,
          },
          TELEGRAM_MESSAGE_LIMIT,
        ),
      );
    });
  });
}

export function registerCommands(bot: Bot, h: HandlerCtx): void {
  registerNavigationCommands(bot, {
    deps: h.deps,
    poster: h.poster,
    say: h.say,
    refreshMember: async ({ chatId, chatTitle, user }) => {
      await ensureChatContext(h, chatId, chatTitle, user);
    },
  });

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
