/**
 * Commands: /start /help /settings /bookit.
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
