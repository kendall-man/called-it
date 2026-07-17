/**
 * grammY bot assembly: middleware order is commands → callbacks → detection,
 * plus the my_chat_member consent hook (admin promotion = passive detection).
 */

import type { Bot } from 'grammy';
import { ensureChatContext, type HandlerCtx } from './context.js';
import { registerCommands } from './commands.js';
import { registerCallbacks } from './callbacks.js';
import { registerDetection } from './detection.js';
import { tableUrl } from '../pipeline/render.js';

export function registerBotHandlers(bot: Bot, h: HandlerCtx): void {
  bot.catch((err) => {
    h.deps.log.error('bot_update_failed', { error: String(err.error) });
  });

  // A command can be a user's first-ever interaction. The wager handlers
  // (/wallet, /deposit, /withdraw) write to wager tables that carry a users
  // FK, and the passive-detection path — which is where every other handler
  // gets its ensureChatContext upsert — skips commands (`text.startsWith('/')`
  // returns early). Without this a first-touch /wallet dies on the FK. Upsert
  // the group + acting user for any group command before its handler runs;
  // the upserts are idempotent, so this is a no-op for returning members.
  bot.on('message:text', async (ctx, next) => {
    const from = ctx.from;
    if (
      from &&
      !from.is_bot &&
      (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') &&
      ctx.message.text.startsWith('/')
    ) {
      await ensureChatContext(h, ctx.chat.id, ctx.chat.title ?? '', from);
    }
    await next();
  });

  bot.on('my_chat_member', async (ctx) => {
    const chat = ctx.chat;
    if (chat.type !== 'group' && chat.type !== 'supergroup') return;
    const next = ctx.myChatMember.new_chat_member.status;
    const previous = ctx.myChatMember.old_chat_member.status;
    const group = await h.deps.db.upsertGroup({ id: chat.id, title: chat.title ?? '' });
    h.deps.log.info('membership_change', { groupId: chat.id, previous, next });

    if (next === 'administrator') {
      await h.deps.db.setGroupAdmin(chat.id, true);
      h.poster.post(chat.id, await h.say('detection_enabled'));
      return;
    }
    if (next === 'member') {
      await h.deps.db.setGroupAdmin(chat.id, false);
      const joined = previous === 'left' || previous === 'kicked';
      const key = joined ? 'intro' : 'detection_disabled';
      h.poster.post(chat.id, await h.say(key, { webUrl: tableUrl(h.deps, group.slug) }));
    }
  });

  registerCommands(bot, h);
  registerCallbacks(bot, h);
  registerDetection(bot, h);
}

export const BOT_COMMANDS = [
  { command: 'status', description: 'Live board: open calls and the match' },
  { command: 'bookit', description: 'Reply to a claim to put it on the record' },
  { command: 'settings', description: 'How chatty should I be? (admins)' },
  { command: 'kickoff', description: 'Start a match (admins)' },
  { command: 'help', description: 'How this works' },
] as const;
