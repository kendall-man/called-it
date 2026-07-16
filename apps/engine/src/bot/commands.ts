/**
 * Commands: private navigation plus group calls and board access. An author
 * can make an explicit call; a friend-triggered call waits for author consent.
 */

import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { User } from 'grammy/types';
import { isWagerAsset, TERMINAL_PHASES } from '@calledit/market-engine';
import type { EngineDb, FixtureRow } from '../ports.js';
import type { Env } from '../env.js';
import type { Poster } from './poster.js';
import { displayName, ensureChatContext, ensureUserSeen, isGroupAdmin, type HandlerCtx } from './context.js';
import { ENGINE } from '../engineConstants.js';
import { settingsKeyboard, voidReplayBlockerKeyboard } from './keyboards.js';
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
import { registerEscrowAccountCommands } from './escrow-commands.js';

const GROUP_LEADERBOARD_LIMIT = 10;
const GROUP_RANK_LIMIT = 100;
const TEST_MATCH_LOOKBACK_MS = 45 * 24 * 60 * 60_000;

function isReplayableFixture(
  fixture: FixtureRow | null,
): fixture is FixtureRow & { kickoff_at: string } {
  return fixture !== null &&
    fixture.kickoff_at !== null &&
    !fixture.coverage_unreliable &&
    TERMINAL_PHASES.includes(fixture.phase);
}

async function resolveTestFixture(h: HandlerCtx, argument: string) {
  if (argument.length > 0) {
    if (!/^\d+$/.test(argument)) return null;
    const fixtureId = Number(argument);
    if (!Number.isSafeInteger(fixtureId) || fixtureId <= 0) return null;
    const fixture = await h.deps.db.getFixture(fixtureId);
    return isReplayableFixture(fixture) ? fixture : null;
  }

  const nowMs = h.deps.now();
  const fixtures = await h.deps.db.fixturesBetween(nowMs - TEST_MATCH_LOOKBACK_MS, nowMs);
  return [...fixtures]
    .filter(isReplayableFixture)
    .filter((fixture) => fixture.phase === 'F')
    .sort((left, right) => Date.parse(right.kickoff_at) - Date.parse(left.kickoff_at))[0] ?? null;
}

function isGroup(chatType: string): boolean {
  return chatType === 'group' || chatType === 'supergroup';
}

async function postLiveCallBlocker(
  h: HandlerCtx,
  groupId: number,
  replyToMessageId: number | undefined,
): Promise<void> {
  let text = await h.say('replay_blocked_live');
  let keyboard: InlineKeyboard | undefined;
  try {
    const markets = (await h.deps.db.openMarketsForGroup(groupId))
      .filter((market) => !market.is_replay);
    const market = markets[0];
    if (market !== undefined) {
      const [claim, positions] = await Promise.all([
        h.deps.db.getClaim(market.claim_id),
        h.deps.db.positionsForMarket(market.id),
      ]);
      const hasPositions = positions.some((position) => position.state !== 'void');
      text = await h.say('replay_blocked_live', {
        call: claim?.quoted_text ?? 'An open call',
        resolution: hasPositions
          ? 'This call has positions and must settle normally.'
          : h.deps.env.WAGER_CUSTODY_MODE === 'escrow'
            ? 'This on-chain escrow call is locked pending a finalized close or refund; it cannot be voided from Telegram.'
            : 'No positions are on it. An admin can void it below.',
      });
      if (!hasPositions && h.deps.env.WAGER_CUSTODY_MODE !== 'escrow') {
        keyboard = voidReplayBlockerKeyboard(market.id);
      }
    }
  } catch {
    h.deps.log.warn('replay_blocker_lookup_failed');
  }
  h.poster.post(groupId, text, { replyToMessageId, ...(keyboard ? { keyboard } : {}) });
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
    readonly env: Pick<Env, 'WEB_BASE_URL' | 'DEPLOYMENT_ENV' | 'BETA_ALLOWED_GROUP_IDS'>
      & Partial<Pick<Env, 'SOLANA_NETWORK' | 'WAGER_CUSTODY_MODE'>>;
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
    if (!isBetaGroupAllowed(h.deps.env, ctx.chat.id)) {
      h.poster.post(ctx.chat.id, await h.say('beta_access_required'));
      return;
    }
    const group = await h.deps.db.upsertGroup({ id: ctx.chat.id, title: ctx.chat.title ?? '' });
    if (!group.is_admin) {
      h.poster.post(ctx.chat.id, await h.say('admin_permission_required'));
      return;
    }
    const plan = await planGroupReadiness({
      store: groupReadyMarkerStore(h.deps.db),
      group,
      webBaseUrl: h.deps.env.WEB_BASE_URL,
      solanaNetwork: h.deps.env.SOLANA_NETWORK,
      custodyMode: h.deps.env.WAGER_CUSTODY_MODE ?? 'legacy',
    });
    if (plan.kind === 'post_ready') h.poster.post(ctx.chat.id, plan.text);
  });

  bot.command('help', async (ctx) => {
    const line = await h.say('help', {
      custodyMode: h.deps.env.WAGER_CUSTODY_MODE ?? 'legacy',
    });
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
  if (h.deps.env.WAGER_CUSTODY_MODE === 'escrow') {
    registerEscrowAccountCommands(bot, {
      webBaseUrl: h.deps.env.WEB_BASE_URL,
      network: h.deps.env.SOLANA_NETWORK,
      escrow: h.escrow,
      ensureUser: async (user) => {
        await h.deps.db.upsertUser({
          id: user.id,
          display_name: displayName(user),
          username: user.username ?? null,
        });
      },
      now: h.deps.now,
    });
  }
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

  bot.command('currency', async (ctx) => {
    if (!isGroup(ctx.chat.type) || !ctx.from) return;
    if (!isBetaGroupAllowed(h.deps.env, ctx.chat.id)) return;
    const from = ctx.from;
    const group = await ensureChatContext(h, ctx.chat.id, ctx.chat.title ?? '', from);
    const wager = h.deps.wager;
    if (wager?.kind !== 'funded') return;
    const admin = await isGroupAdmin(h, () => ctx.getChatMember(from.id));
    if (!admin) {
      h.poster.post(ctx.chat.id, await h.say('admin_only'), {
        replyToMessageId: ctx.message?.message_id,
      });
      return;
    }
    const requested = (ctx.match ?? '').toString().trim().toLowerCase();
    if (requested === '') {
      const current = await wager.currencyForMint(group.id);
      const asset = current === 'usdc' ? 'usdc' : 'sol';
      h.poster.post(ctx.chat.id, wager.groupAssetMessage(asset, false), {
        replyToMessageId: ctx.message?.message_id,
      });
      return;
    }
    if (!isWagerAsset(requested)) {
      h.poster.post(ctx.chat.id, 'Use /currency sol or /currency usdc.', {
        replyToMessageId: ctx.message?.message_id,
      });
      return;
    }
    await wager.setGroupDefaultAsset(group.id, requested, from.id);
    h.poster.post(ctx.chat.id, wager.groupAssetMessage(requested, true), {
      replyToMessageId: ctx.message?.message_id,
    });
  });

  bot.command('testmatch', async (ctx) => {
    if (!isGroup(ctx.chat.type) || !ctx.from) return;
    if (!isBetaGroupAllowed(h.deps.env, ctx.chat.id)) return;
    const from = ctx.from;
    const group = await ensureChatContext(h, ctx.chat.id, ctx.chat.title ?? '', from);
    const replyToMessageId = ctx.message?.message_id;
    const admin = await isGroupAdmin(h, () => ctx.getChatMember(from.id));
    if (!admin) {
      h.poster.post(ctx.chat.id, await h.say('admin_only'), { replyToMessageId });
      return;
    }
    if (h.supervisor.hasActiveReplay(group.id)) {
      h.poster.post(ctx.chat.id, await h.say('replay_blocked_active'), { replyToMessageId });
      return;
    }

    let fixture;
    try {
      fixture = await resolveTestFixture(h, (ctx.match ?? '').toString().trim());
    } catch {
      h.deps.log.warn('test_match_lookup_failed');
      h.poster.post(ctx.chat.id, await h.say('hiccup'), { replyToMessageId });
      return;
    }
    if (fixture === null) {
      h.poster.post(ctx.chat.id, await h.say('replay_unknown_fixture'), { replyToMessageId });
      return;
    }

    try {
      const result = await h.supervisor.startReplay(
        group.id,
        fixture,
        ENGINE.REPLAY_SPEED,
        ENGINE.REPLAY_SETUP_GRACE_MS,
      );
      if (result === 'already_active') {
        h.poster.post(ctx.chat.id, await h.say('replay_blocked_active'), { replyToMessageId });
        return;
      }
      if (result === 'live_markets') {
        await postLiveCallBlocker(h, group.id, replyToMessageId);
        return;
      }
    } catch {
      h.deps.log.warn('test_match_start_failed', { fixtureId: fixture.fixture_id });
      h.poster.post(ctx.chat.id, await h.say('hiccup'), { replyToMessageId });
      return;
    }
    h.poster.post(
      ctx.chat.id,
      await h.say('replay_started', {
        fixture: `${fixture.p1_name} vs ${fixture.p2_name}`,
        p1: fixture.p1_name,
        p2: fixture.p2_name,
        custodyMode: h.deps.env.WAGER_CUSTODY_MODE,
      }),
      { replyToMessageId },
    );
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
