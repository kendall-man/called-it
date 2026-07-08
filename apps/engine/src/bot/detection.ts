/**
 * Passive claim detection (the product's identity):
 * message → deterministic prefilter → classifier → immediate priced offer
 * (high confidence, nudge mode) or silent 👀 (medium), gated on the group's
 * chattiness AND the bot's admin status (the per-group consent lever).
 * Trigger paths (@mention, "book it" reply) bypass the classifier and always
 * post their result.
 */

import type { Bot } from 'grammy';
import { TUNABLES } from '@calledit/market-engine';
import { ensureChatContext, ensureUserSeen, type HandlerCtx } from './context.js';
import { offerClaim } from '../pipeline/offer.js';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const BOOK_IT_RE = /^book\s*it\W*$/i;

export function registerDetection(bot: Bot, h: HandlerCtx): void {
  bot.on('message:text', async (ctx) => {
    const chat = ctx.chat;
    if (chat.type !== 'group' && chat.type !== 'supergroup') return;
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

    if (result.confidence >= TUNABLES.CLASSIFIER_NUDGE_THRESHOLD && group.chattiness === 'nudge') {
      // High confidence: parse + price + offer immediately. Silent on parse
      // failures (this was auto-detected, not an explicit ask).
      await offerClaim(h, {
        chatId: chat.id,
        group,
        text,
        claimer: from,
        sourceMessageId: ctx.message.message_id,
        confidence: result.confidence,
        announce: false,
      });
      return;
    }
    if (result.confidence >= TUNABLES.CLASSIFIER_REACT_THRESHOLD) {
      // Low-noise acknowledgment; the row lets a later /bookit trace lineage.
      try {
        await ctx.react('👀');
      } catch (err) {
        h.deps.log.warn('react_failed', { groupId: group.id, error: String(err) });
      }
      await h.deps.db.insertClaim({
        group_id: chat.id,
        claimer_user_id: from.id,
        tg_message_id: ctx.message.message_id,
        quoted_text: text,
        status: 'detected',
        classifier_confidence: result.confidence,
        expires_at: new Date(h.deps.now() + TUNABLES.UNCONFIRMED_CLAIM_TTL_MS).toISOString(),
      });
    }
  });
}
