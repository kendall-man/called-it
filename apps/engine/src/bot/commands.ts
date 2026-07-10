/**
 * Commands: /start /help /settings /replay /bookit.
 * /bookit and @mention are the consent-free trigger path (privacy mode ON
 * delivers commands and replies in every group).
 */

import type { Bot } from 'grammy';
import { ensureChatContext, ensureUserSeen, isGroupAdmin, type HandlerCtx } from './context.js';
import { settingsKeyboard } from './keyboards.js';
import { offerClaim } from '../pipeline/offer.js';
import { tableUrl } from '../pipeline/render.js';

function isGroup(chatType: string): boolean {
  return chatType === 'group' || chatType === 'supergroup';
}

export function registerCommands(bot: Bot, h: HandlerCtx): void {
  bot.command('start', async (ctx) => {
    if (!isGroup(ctx.chat.type)) {
      const addLink = `https://t.me/${ctx.me.username}?startgroup=true`;
      const line = await h.say('dm_start', { addLink });
      h.poster.post(ctx.chat.id, line);
      return;
    }
    const group = await ensureChatContext(h, ctx.chat.id, ctx.chat.title ?? '', ctx.from);
    const line = await h.say('intro', { webUrl: tableUrl(h.deps, group.slug) });
    h.poster.post(ctx.chat.id, line);
  });

  bot.command('help', async (ctx) => {
    const line = await h.say('help');
    h.poster.post(ctx.chat.id, line);
  });

  bot.command('settings', async (ctx) => {
    if (!isGroup(ctx.chat.type) || !ctx.from) return;
    const group = await ensureChatContext(h, ctx.chat.id, ctx.chat.title ?? '', ctx.from);
    const admin = await isGroupAdmin(h, () => ctx.getChatMember(ctx.from!.id));
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

  bot.command('replay', async (ctx) => {
    if (!isGroup(ctx.chat.type) || !ctx.from) return;
    const group = await ensureChatContext(h, ctx.chat.id, ctx.chat.title ?? '', ctx.from);
    const admin = await isGroupAdmin(h, () => ctx.getChatMember(ctx.from!.id));
    const replyTo = ctx.message?.message_id;
    if (!admin) {
      h.poster.post(ctx.chat.id, await h.say('admin_only'), { replyToMessageId: replyTo });
      return;
    }
    const arg = (ctx.match ?? '').toString().trim();
    if (arg.toLowerCase() === 'stop') {
      const stopped = h.supervisor.stopReplay(group.id);
      h.poster.post(ctx.chat.id, await h.say(stopped ? 'replay_stopped' : 'stale'), {
        replyToMessageId: replyTo,
      });
      return;
    }
    const fixtureId = Number.parseInt(arg, 10);
    if (!Number.isFinite(fixtureId) || fixtureId <= 0) {
      h.poster.post(ctx.chat.id, await h.say('replay_unknown_fixture'), { replyToMessageId: replyTo });
      return;
    }
    if (h.supervisor.hasActiveReplay(group.id)) {
      h.poster.post(ctx.chat.id, await h.say('replay_blocked_active'), { replyToMessageId: replyTo });
      return;
    }
    // Only a non-replay market with real money on it blocks a replay — the
    // broker auto-mints offer markets from banter, and an untouched zero-bet
    // one must never brick a demo.
    const openMarkets = await h.deps.db.openMarketsForGroup(group.id);
    let liveBetInPlay = false;
    for (const market of openMarkets) {
      if (market.is_replay) continue;
      const positions = await h.deps.db.positionsForMarket(market.id);
      if (positions.some((position) => position.state !== 'void')) {
        liveBetInPlay = true;
        break;
      }
    }
    if (liveBetInPlay) {
      h.poster.post(ctx.chat.id, await h.say('replay_blocked_live'), { replyToMessageId: replyTo });
      return;
    }
    const fixture = await h.deps.db.getFixture(fixtureId);
    if (!fixture) {
      h.poster.post(ctx.chat.id, await h.say('replay_unknown_fixture'), { replyToMessageId: replyTo });
      return;
    }
    await h.supervisor.startReplay(group.id, fixtureId);
    h.poster.post(
      ctx.chat.id,
      await h.say('replay_started', { fixture: `${fixture.p1_name} vs ${fixture.p2_name}` }),
      { replyToMessageId: replyTo },
    );
  });

  bot.command('bookit', async (ctx) => {
    if (!isGroup(ctx.chat.type) || !ctx.from) return;
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
    });
  });

  // Wager commands (/wallet, /deposit, /withdraw, …) exist only while the
  // module is live; the flag-off bot registers exactly the handlers above.
  h.deps.wager?.registerCommands(bot);
}
