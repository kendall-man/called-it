/**
 * Callback-query handlers — the whole loop lives on inline buttons:
 * Make him prove it → clarify / counter-offer options → That's my shout →
 * Back/Doubt stakes. Every tap resolves against DB rows via ids carried in
 * callback_data; anything unresolvable gets a deterministic in-character
 * "that ship has sailed" (PRD story 17).
 */

import type { Bot, Context } from 'grammy';
import { TUNABLES } from '@calledit/market-engine';
import type { ClaimRow, GroupRow, MarketRow } from '../ports.js';
import { decodeCallback, type CallbackAction } from './callbackData.js';
import { displayName, ensureUserSeen, isGroupAdmin, type HandlerCtx } from './context.js';
import { confirmKeyboard, optionsKeyboard, settingsKeyboard, stakeKeyboard } from './keyboards.js';
import { describeTerms, formatMultiplier, formatProbabilityPct, statusLine } from './cards.js';
import {
  checkMintWindow,
  createMarketFromClaim,
  doubtMultiplier,
  proveClaim,
  quoteSpec,
  readEnvelope,
  type ParseEnvelope,
} from '../pipeline/claims.js';
import { composeClaimCard } from '../pipeline/render.js';
import { renderFallback } from './copy.js';

function multiplierBare(multiplier: number): string {
  return formatMultiplier(multiplier).replace('×', '');
}

async function answer(ctx: Context, text: string): Promise<void> {
  try {
    await ctx.answerCallbackQuery({ text: text.slice(0, 190) });
  } catch {
    // stale query ids are expected after restarts — nothing to do
  }
}

async function stale(h: HandlerCtx, ctx: Context): Promise<void> {
  await answer(ctx, await h.say('stale'));
}

function claimIsExpired(claim: ClaimRow, nowMs: number): boolean {
  return claim.expires_at !== null && Date.parse(claim.expires_at) <= nowMs;
}

async function loadClaimForChat(
  h: HandlerCtx,
  ctx: Context,
  claimId: string,
): Promise<{ claim: ClaimRow; group: GroupRow } | null> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return null;
  const claim = await h.deps.db.getClaim(claimId);
  if (!claim || claim.group_id !== chatId) return null;
  const group = await h.deps.db.getGroup(chatId);
  if (!group) return null;
  return { claim, group };
}

/** Quote the picked spec, stash it, and post the "That's my shout" gate. */
async function presentConfirmGate(
  h: HandlerCtx,
  ctx: Context,
  claim: ClaimRow,
  envelope: ParseEnvelope,
  optionKey: string,
): Promise<void> {
  const option = envelope.options.find((candidate) => candidate.key === optionKey);
  if (!option) {
    await stale(h, ctx);
    return;
  }
  const quote = await quoteSpec(h.deps, option.spec);
  if (!quote) {
    await h.deps.db.updateClaim(claim.id, { status: 'nudged' });
    h.poster.post(claim.group_id, await h.say('no_price'));
    return;
  }
  const updated: ParseEnvelope = {
    ...envelope,
    chosen: option.spec,
    quote: {
      probability: quote.probability,
      multiplier: quote.multiplier,
      provenance: quote.provenance,
      oddsMessageId: quote.oddsMessageId,
      oddsTsMs: quote.oddsTsMs,
    },
  };
  await h.deps.db.updateClaim(claim.id, { status: 'awaiting_confirm', parse: updated });
  const claimer = await h.deps.db.getUser(claim.claimer_user_id);
  const gate = await h.say('confirm_gate', {
    terms: describeTerms(option.spec),
    probabilityPct: formatProbabilityPct(quote.probability),
    multiplier: multiplierBare(quote.multiplier),
    claimer: claimer?.display_name ?? 'claimer',
  });
  h.poster.post(claim.group_id, gate, {
    replyToMessageId: claim.tg_message_id,
    keyboard: confirmKeyboard(claim.id),
  });
}

async function handleProve(h: HandlerCtx, ctx: Context, claimId: string): Promise<void> {
  const loaded = await loadClaimForChat(h, ctx, claimId);
  if (!loaded) {
    await stale(h, ctx);
    return;
  }
  const { claim } = loaded;
  if (
    (claim.status !== 'nudged' && claim.status !== 'detected') ||
    claimIsExpired(claim, h.deps.now())
  ) {
    await stale(h, ctx);
    return;
  }
  await answer(ctx, await h.say('prove_ack'));
  // Block double-taps while the parse runs.
  await h.deps.db.updateClaim(claim.id, { status: 'clarifying' });

  const outcome = await proveClaim(h.deps, claim);
  if (outcome.kind === 'reject') {
    await h.deps.db.updateClaim(claim.id, { status: 'declined' });
    h.poster.post(claim.group_id, await h.say('reject', { message: outcome.message }), {
      replyToMessageId: claim.tg_message_id,
    });
    return;
  }
  const envelope = outcome.envelope;
  await h.deps.db.updateClaim(claim.id, { parse: envelope });

  if (envelope.kind === 'ok') {
    await presentConfirmGate(h, ctx, claim, envelope, 'ok');
    return;
  }
  const claimerUser = await h.deps.db.getUser(claim.claimer_user_id);
  const upgradeOption = envelope.options.find((option) => option.key === 'up');
  const promptKey = envelope.kind === 'clarify' ? 'clarify' : 'counter_offer';
  const prompt = await h.say(promptKey, {
    question: envelope.question ?? '',
    reason: envelope.reason ?? '',
    claimer: claimerUser?.display_name ?? 'legend',
    offer: upgradeOption ? describeTerms(upgradeOption.spec) : '',
  });
  h.poster.post(claim.group_id, prompt, {
    replyToMessageId: claim.tg_message_id,
    keyboard: optionsKeyboard(
      claim.id,
      envelope.options.map(({ key, label }) => ({ key, label })),
    ),
  });
}

async function handleOption(
  h: HandlerCtx,
  ctx: Context,
  claimId: string,
  optionKey: string,
): Promise<void> {
  const loaded = await loadClaimForChat(h, ctx, claimId);
  if (!loaded) {
    await stale(h, ctx);
    return;
  }
  const { claim } = loaded;
  // 'awaiting_confirm' is allowed so the claimer can switch options before confirming.
  const pickable: ClaimRow['status'][] = ['clarifying', 'awaiting_confirm'];
  if (!pickable.includes(claim.status) || claimIsExpired(claim, h.deps.now())) {
    await stale(h, ctx);
    return;
  }
  if (ctx.from?.id !== claim.claimer_user_id) {
    const claimer = await h.deps.db.getUser(claim.claimer_user_id);
    await answer(
      ctx,
      await h.say('claimer_only_terms', { claimer: claimer?.display_name ?? 'the claimer' }),
    );
    return;
  }
  const envelope = readEnvelope(claim);
  if (!envelope) {
    await stale(h, ctx);
    return;
  }
  await answer(ctx, 'Locking terms…');
  await presentConfirmGate(h, ctx, claim, envelope, optionKey);
}

async function handleConfirm(h: HandlerCtx, ctx: Context, claimId: string): Promise<void> {
  const loaded = await loadClaimForChat(h, ctx, claimId);
  if (!loaded) {
    await stale(h, ctx);
    return;
  }
  const { claim, group } = loaded;
  if (claim.status !== 'awaiting_confirm' || claimIsExpired(claim, h.deps.now())) {
    await stale(h, ctx);
    return;
  }
  if (ctx.from?.id !== claim.claimer_user_id) {
    const claimer = await h.deps.db.getUser(claim.claimer_user_id);
    await answer(
      ctx,
      await h.say('not_your_shout', { claimer: claimer?.display_name ?? 'the claimer' }),
    );
    return;
  }
  const envelope = readEnvelope(claim);
  const spec = envelope?.chosen;
  const storedQuote = envelope?.quote;
  if (!envelope || !spec || !storedQuote) {
    await stale(h, ctx);
    return;
  }
  const fixture = await h.deps.db.getFixture(spec.fixtureId);
  const window = checkMintWindow(spec, fixture, h.deps.now());
  if (!window.open || !fixture) {
    await h.deps.db.updateClaim(claim.id, { status: 'expired' });
    await answer(ctx, await h.say('window_closed'));
    return;
  }
  await answer(ctx, 'Locked. 🎙');

  // Re-price at the confirm moment; fall back to the gate quote if odds blink.
  const freshQuote = await quoteSpec(h.deps, spec);
  const quote = freshQuote
    ? {
        probability: freshQuote.probability,
        multiplier: freshQuote.multiplier,
        provenance: freshQuote.provenance,
        oddsMessageId: freshQuote.oddsMessageId,
        oddsTsMs: freshQuote.oddsTsMs,
      }
    : storedQuote;

  const isReplay = h.supervisor.replayFixture(group.id) === spec.fixtureId;
  const market = await createMarketFromClaim(h.deps, {
    claim,
    group,
    spec,
    quote,
    isReplay,
    fixture,
  });

  const card = await composeClaimCard(h.deps, market);
  if (!card) return;
  const garnish = await h.say('market_live', {
    claimer: displayName({ first_name: ctx.from.first_name, last_name: ctx.from.last_name }),
  });
  const pendingNote =
    market.status === 'pending_lineup' ? `\n${await h.say('pending_lineup_note')}` : '';
  h.poster.post(claim.group_id, `${garnish}${pendingNote}\n\n${card.text}`, {
    keyboard: stakeKeyboard(market.id),
    onSent: async (messageId) => {
      await h.deps.db.setMarketCardMessage(market.id, messageId);
    },
  });
}

async function handleDecline(h: HandlerCtx, ctx: Context, claimId: string): Promise<void> {
  const loaded = await loadClaimForChat(h, ctx, claimId);
  if (!loaded) {
    await stale(h, ctx);
    return;
  }
  const { claim } = loaded;
  const declinable: ClaimRow['status'][] = ['nudged', 'clarifying', 'awaiting_confirm'];
  if (!declinable.includes(claim.status)) {
    await stale(h, ctx);
    return;
  }
  if (ctx.from?.id !== claim.claimer_user_id) {
    const claimer = await h.deps.db.getUser(claim.claimer_user_id);
    await answer(
      ctx,
      await h.say('not_your_shout', { claimer: claimer?.display_name ?? 'the claimer' }),
    );
    return;
  }
  await h.deps.db.updateClaim(claim.id, { status: 'declined' });
  await answer(ctx, await h.say('confirm_declined'));
}

async function handleStake(
  h: HandlerCtx,
  ctx: Context,
  action: Extract<CallbackAction, { t: 'stake' }>,
): Promise<void> {
  const chatId = ctx.chat?.id;
  const from = ctx.from;
  if (chatId === undefined || !from) {
    await stale(h, ctx);
    return;
  }
  const market: MarketRow | null = await h.deps.db.getMarket(action.marketId);
  if (!market || market.group_id !== chatId) {
    await stale(h, ctx);
    return;
  }
  if (market.status !== 'open' && market.status !== 'pending_lineup') {
    await answer(ctx, `${statusLine(market.status)}.`);
    return;
  }
  const stakeAmount = TUNABLES.PRESET_STAKES[action.presetIndex];
  if (stakeAmount === undefined) {
    await stale(h, ctx);
    return;
  }
  const fixture = await h.deps.db.getFixture(market.fixture_id);
  const inPlay = fixture !== null && fixture.phase !== 'NS';
  if (
    inPlay &&
    fixture.minute !== null &&
    fixture.minute >= TUNABLES.INPLAY_STAKE_CUTOFF_MINUTE
  ) {
    await answer(ctx, await h.say('window_closed'));
    return;
  }

  await ensureUserSeen(h, chatId, from);
  const positions = await h.deps.db.positionsForMarket(market.id);
  const mine = positions.filter((p) => p.user_id === from.id && p.state !== 'void');
  if (mine.some((p) => p.side !== action.side)) {
    await answer(ctx, await h.say('pick_a_lane', { user: displayName(from) }));
    return;
  }
  const committed = mine.reduce((sum, p) => sum + p.stake, 0);
  if (committed + stakeAmount > TUNABLES.PER_MARKET_STAKE_CAP) {
    await answer(ctx, await h.say('cap_reached', { cap: TUNABLES.PER_MARKET_STAKE_CAP }));
    return;
  }
  const balance = await h.deps.db.balance(chatId, from.id);
  if (balance < stakeAmount) {
    await answer(ctx, await h.say('insufficient_rep', { balance, user: displayName(from) }));
    return;
  }

  const lockedMultiplier =
    action.side === 'back' ? market.quote_multiplier : doubtMultiplier(market.quote_probability);
  const position = await h.deps.db.insertPosition({
    market_id: market.id,
    user_id: from.id,
    side: action.side,
    stake: stakeAmount,
    locked_multiplier: lockedMultiplier,
    locked_odds_message_id: market.odds_message_id,
    locked_odds_ts: market.odds_ts,
    // Pre-kickoff taps activate immediately; in-play taps ride the
    // delay-arbitrage pending window (PENDING_TAP_WINDOW_MS in the engine).
    state: inPlay ? 'pending' : 'active',
    placed_at_ms: h.deps.now(),
  });
  await h.deps.db.postLedger({
    group_id: chatId,
    user_id: from.id,
    market_id: market.id,
    kind: 'stake',
    amount: -stakeAmount,
    idempotency_key: `stake:${position.id}`,
  });
  h.deps.log.info('position_placed', {
    marketId: market.id,
    positionId: position.id,
    userId: from.id,
    side: action.side,
    stake: stakeAmount,
    state: position.state,
  });
  await answer(
    ctx,
    await h.say('stake_locked', {
      name: displayName(from),
      side: action.side === 'back' ? 'Backing' : 'Doubting',
      stake: stakeAmount,
      multiplier: multiplierBare(lockedMultiplier),
    }),
  );
  // Refresh the card tally (collapsed per tunables).
  const fresh = await h.deps.db.getMarket(market.id);
  if (fresh && fresh.card_tg_message_id !== null) {
    const card = await composeClaimCard(h.deps, fresh);
    if (card && card.messageId !== null) {
      h.poster.editCard(chatId, fresh.id, card.messageId, card.text, stakeKeyboard(fresh.id));
    }
  }
}

async function handleChattiness(
  h: HandlerCtx,
  ctx: Context,
  mode: Extract<CallbackAction, { t: 'chattiness' }>['mode'],
): Promise<void> {
  const chatId = ctx.chat?.id;
  const from = ctx.from;
  if (chatId === undefined || !from) {
    await stale(h, ctx);
    return;
  }
  const admin = await isGroupAdmin(h, () => ctx.api.getChatMember(chatId, from.id));
  if (!admin) {
    await answer(ctx, await h.say('admin_only'));
    return;
  }
  await h.deps.db.setGroupChattiness(chatId, mode);
  const group = await h.deps.db.getGroup(chatId);
  const summary =
    mode === 'nudge'
      ? 'priced nudges are on'
      : mode === 'react_only'
        ? 'reactions only from here'
        : 'trigger-only — reply /bookit when it matters';
  await answer(ctx, await h.say('settings_updated', { summary }));
  try {
    await ctx.editMessageReplyMarkup({
      reply_markup: settingsKeyboard(mode, group?.web_enabled ?? true),
    });
  } catch {
    // fine — the settings message may be old
  }
}

async function handleWeb(h: HandlerCtx, ctx: Context, enabled: boolean): Promise<void> {
  const chatId = ctx.chat?.id;
  const from = ctx.from;
  if (chatId === undefined || !from) {
    await stale(h, ctx);
    return;
  }
  const admin = await isGroupAdmin(h, () => ctx.api.getChatMember(chatId, from.id));
  if (!admin) {
    await answer(ctx, await h.say('admin_only'));
    return;
  }
  await h.deps.db.setGroupWebEnabled(chatId, enabled);
  const group = await h.deps.db.getGroup(chatId);
  await answer(
    ctx,
    await h.say('settings_updated', {
      summary: enabled ? 'web pages are visible' : 'web pages are hidden',
    }),
  );
  try {
    await ctx.editMessageReplyMarkup({
      reply_markup: settingsKeyboard(group?.chattiness ?? 'nudge', enabled),
    });
  } catch {
    // fine
  }
}

export function registerCallbacks(bot: Bot, h: HandlerCtx): void {
  bot.on('callback_query:data', async (ctx) => {
    const action = decodeCallback(ctx.callbackQuery.data);
    if (!action) {
      await answer(ctx, renderFallback('stale'));
      return;
    }
    try {
      switch (action.t) {
        case 'prove':
          await handleProve(h, ctx, action.claimId);
          break;
        case 'option':
          await handleOption(h, ctx, action.claimId, action.key);
          break;
        case 'confirm':
          await handleConfirm(h, ctx, action.claimId);
          break;
        case 'decline':
          await handleDecline(h, ctx, action.claimId);
          break;
        case 'stake':
          await handleStake(h, ctx, action);
          break;
        case 'chattiness':
          await handleChattiness(h, ctx, action.mode);
          break;
        case 'web':
          await handleWeb(h, ctx, action.enabled);
          break;
      }
    } catch (err) {
      h.deps.log.error('callback_failed', { action: action.t, error: String(err) });
      await answer(ctx, renderFallback('stale'));
    }
  });
}
