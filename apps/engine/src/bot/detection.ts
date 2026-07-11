/**
 * Passive claim detection (the product's identity):
 * message → deterministic prefilter → classifier → owner confirmation. The
 * only direct path is the author's own mention or own "book it" reply; a
 * passive detection or friend trigger never parses, prices, or publishes terms
 * until the original speaker confirms.
 */

import type { Bot } from 'grammy';
import { TUNABLES } from '@calledit/market-engine';
import { ensureChatContext, ensureUserSeen, type HandlerCtx } from './context.js';
import { offerClaim } from '../pipeline/offer.js';
import { isBetaGroupAllowed } from './beta-access.js';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const BOOK_IT_RE = /^book\s*it\W*$/i;

export function registerDetection(bot: Bot, h: HandlerCtx): void {
  bot.on('message:text', async (ctx) => {
    const chat = ctx.chat;
    if (chat.type !== 'group' && chat.type !== 'supergroup') return;
    if (!isBetaGroupAllowed(h.deps.env, chat.id)) return;
    const from = ctx.from;
    if (!from || from.is_bot) return;
    const text = ctx.message.text;
    if (text.startsWith('/')) return; // commands have their own handlers

    const group = await ensureChatContext(h, chat.id, chat.title ?? '', from);

    // Trigger path 1: @mention — claim text in the same message, or a bare
    // mention replying to the claim itself.
    const mentionRe = new RegExp(`@${escapeRegExp(ctx.me.username)}\\b`, 'i');
    if (mentionRe.test(text)) {
      const stripped = text.replace(mentionRe, ' ').replace(/\s+/g, ' ').trim();
      const mentionReply = ctx.message.reply_to_message;
      if (stripped.length > 0) {
        await offerClaim(h, {
          chatId: chat.id,
          group,
          text: stripped,
          claimer: from,
          sourceMessageId: ctx.message.message_id,
          confidence: null,
          announce: true,
          consent: 'explicit',
        });
      } else if (mentionReply?.text && mentionReply.from && !mentionReply.from.is_bot) {
        await ensureUserSeen(h, chat.id, mentionReply.from);
        await offerClaim(h, {
          chatId: chat.id,
          group,
          text: mentionReply.text,
          claimer: mentionReply.from,
          sourceMessageId: mentionReply.message_id,
          confidence: null,
          announce: true,
          consent: mentionReply.from.id === from.id ? 'explicit' : 'awaiting_confirm',
        });
      }
      return;
    }

    // Trigger path 2: plain "book it" reply — convenience alias, admin groups only.
    const replyTarget = ctx.message.reply_to_message;
    if (replyTarget && BOOK_IT_RE.test(text.trim())) {
      if (group.is_admin && replyTarget.text && replyTarget.from && !replyTarget.from.is_bot) {
        await ensureUserSeen(h, chat.id, replyTarget.from);
        await offerClaim(h, {
          chatId: chat.id,
          group,
          text: replyTarget.text,
          claimer: replyTarget.from,
          sourceMessageId: replyTarget.message_id,
          confidence: null,
          announce: true,
          consent: replyTarget.from.id === from.id ? 'explicit' : 'awaiting_confirm',
        });
      }
      return;
    }

    // Passive path: consent (admin) + chattiness + prefilter + budget + classifier.
    if (!group.is_admin || group.chattiness === 'trigger_only') return;
    const entities = await h.entities.get();
    if (!h.deps.agent.prefilter(text, entities)) return;
    if (!h.budget.allow(group.id)) {
      h.deps.log.info('llm_budget_exhausted', { groupId: group.id });
      return;
    }

    let result;
    try {
      result = await h.deps.agent.classify(text, entities);
    } catch (err) {
      h.deps.log.warn('classify_failed', { groupId: group.id, error: String(err) });
      return;
    }
    h.deps.log.info('classified', {
      groupId: group.id,
      isClaim: result.isClaim,
      confidence: result.confidence,
      guess: result.claimTypeGuess,
    });
    if (!result.isClaim) return;

    if (result.confidence >= TUNABLES.CLASSIFIER_REACT_THRESHOLD) {
      // Passive classification only establishes enough confidence to ask the
      // author. The compiler has not seen the raw call yet, so no public terms
      // or quote can exist before their explicit confirmation.
      await offerClaim(h, {
        chatId: chat.id,
        group,
        text,
        claimer: from,
        sourceMessageId: ctx.message.message_id,
        confidence: result.confidence,
        announce: false,
        consent: 'awaiting_confirm',
      });
    }
  });
}
