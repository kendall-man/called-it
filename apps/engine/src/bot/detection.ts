/**
 * Passive claim detection (the product's identity):
 * message → deterministic prefilter → classifier → priced nudge (high
 * confidence, nudge mode) or silent 👀 (medium), gated on the group's
 * chattiness AND the bot's admin status (the per-group consent lever).
 * Trigger paths (@mention, "book it" reply) bypass the classifier.
 */

import type { Bot } from 'grammy';
import type { User } from 'grammy/types';
import { TUNABLES } from '@calledit/market-engine';
import type { GroupRow } from '../ports.js';
import { displayName, ensureChatContext, ensureUserSeen, type HandlerCtx } from './context.js';
import { nudgeKeyboard } from './keyboards.js';
import { formatMultiplier } from './cards.js';
import { guessNudgeProbability } from '../pipeline/nudgePrice.js';

const NUDGE_QUOTE_MAX_CHARS = 90;

function clampMultiplier(probability: number): number {
  return Math.min(TUNABLES.MULTIPLIER_MAX, Math.max(TUNABLES.MULTIPLIER_MIN, 1 / probability));
}

const BOOK_IT_RE = /^book\s*it\W*$/i;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface NudgeArgs {
  chatId: number;
  group: GroupRow;
  text: string;
  claimer: User;
  sourceMessageId: number;
  confidence: number | null;
  claimTypeGuess: string | null;
}

/** Insert the claim row and post the (best-effort priced) nudge. */
export async function nudgeClaim(h: HandlerCtx, args: NudgeArgs): Promise<void> {
  const expiresAt = new Date(h.deps.now() + TUNABLES.UNCONFIRMED_CLAIM_TTL_MS).toISOString();
  const claim = await h.deps.db.insertClaim({
    group_id: args.chatId,
    claimer_user_id: args.claimer.id,
    tg_message_id: args.sourceMessageId,
    quoted_text: args.text,
    status: 'nudged',
    classifier_confidence: args.confidence,
    expires_at: expiresAt,
  });
  h.deps.log.info('nudged', {
    claimId: claim.id,
    groupId: args.chatId,
    confidence: args.confidence,
  });
  const price = await guessNudgeProbability(h.deps, args.text, args.claimTypeGuess);
  const claimerName = displayName(args.claimer);
  const quote =
    args.text.length > NUDGE_QUOTE_MAX_CHARS
      ? `${args.text.slice(0, NUDGE_QUOTE_MAX_CHARS - 1)}…`
      : args.text;
  const line = price
    ? await h.say('nudge_priced', {
        claimer: claimerName,
        probabilityPct: price.probabilityPct,
        quote,
        multiplier: formatMultiplier(clampMultiplier(price.probability)).replace('×', ''),
      })
    : await h.say('nudge_unpriced', { claimer: claimerName });
  h.poster.post(args.chatId, line, {
    replyToMessageId: args.sourceMessageId,
    keyboard: nudgeKeyboard(claim.id),
  });
}

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
        await nudgeClaim(h, {
          chatId: chat.id,
          group,
          text: stripped,
          claimer: from,
          sourceMessageId: ctx.message.message_id,
          confidence: null,
          claimTypeGuess: null,
        });
      } else if (mentionReply?.text && mentionReply.from && !mentionReply.from.is_bot) {
        await ensureUserSeen(h, chat.id, mentionReply.from);
        await nudgeClaim(h, {
          chatId: chat.id,
          group,
          text: mentionReply.text,
          claimer: mentionReply.from,
          sourceMessageId: mentionReply.message_id,
          confidence: null,
          claimTypeGuess: null,
        });
      }
      return;
    }

    // Trigger path 2: plain "book it" reply — convenience alias, admin groups only.
    const replyTarget = ctx.message.reply_to_message;
    if (replyTarget && BOOK_IT_RE.test(text.trim())) {
      if (group.is_admin && replyTarget.text && replyTarget.from && !replyTarget.from.is_bot) {
        await ensureUserSeen(h, chat.id, replyTarget.from);
        await nudgeClaim(h, {
          chatId: chat.id,
          group,
          text: replyTarget.text,
          claimer: replyTarget.from,
          sourceMessageId: replyTarget.message_id,
          confidence: null,
          claimTypeGuess: null,
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
      await nudgeClaim(h, {
        chatId: chat.id,
        group,
        text,
        claimer: from,
        sourceMessageId: ctx.message.message_id,
        confidence: result.confidence,
        claimTypeGuess: result.claimTypeGuess,
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
