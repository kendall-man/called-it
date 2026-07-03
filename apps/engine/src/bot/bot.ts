/**
 * grammY bot assembly: middleware order is commands → callbacks → detection,
 * plus the my_chat_member consent hook (admin promotion = passive detection).
 */

import type { Bot } from 'grammy';
import type { HandlerCtx } from './context.js';
import { registerCommands } from './commands.js';
import { registerCallbacks } from './callbacks.js';
import { registerDetection } from './detection.js';
import { tableUrl } from '../pipeline/render.js';

export function registerBotHandlers(bot: Bot, h: HandlerCtx): void {
  bot.catch((err) => {
    h.deps.log.error('bot_update_failed', { error: String(err.error) });
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
  { command: 'bookit', description: 'Reply to a claim to put it on the record' },
  { command: 'table', description: 'The group leaderboard' },
  { command: 'settings', description: 'How chatty should I be? (admins)' },
  { command: 'replay', description: 'Re-run a finished match (admins)' },
  { command: 'help', description: 'How this works' },
] as const;
