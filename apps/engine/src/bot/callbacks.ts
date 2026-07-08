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
import {
  confirmKeyboard,
  optionsKeyboard,
  retryQuoteKeyboard,
  settingsKeyboard,
  stakeKeyboard,
} from './keyboards.js';
import { describeTerms, formatMultiplier, formatProbabilityPct, statusLine } from './cards.js';
import {
  checkMintWindow,
  createMarketFromClaim,
  isDegenerateQuote,
  proveClaim,
  quoteSpec,
  readEnvelope,
  type ParseEnvelope,
} from '../pipeline/claims.js';
import { executeStake } from '../pipeline/stake.js';
import { composeClaimCard } from '../pipeline/render.js';
import { renderFallback, type TemplateKey } from './copy.js';

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

/**
 * The claim TTL is an INACTIVITY deadline: every meaningful interaction
 * (prove tap, option pick, confirm-gate present) pushes it forward so the
 * cron sweeper can't expire a conversation that is actively moving.
 */
function extendedClaimExpiry(h: HandlerCtx): string {
  return new Date(h.deps.now() + TUNABLES.UNCONFIRMED_CLAIM_TTL_MS).toISOString();
}

/**
 * Per-claim in-process mutex. The grammY runner processes callback queries
 * concurrently (no sequentialize middleware), so two taps on the same claim
 * can interleave between a status read and its write — the classic path to
 * double LLM parses and double-minted markets. The engine is a single Node
 * process, so a Set is a sufficient critical-section guard (the deployed
 * schema has no unique index on markets.claim_id to lean on).
 */
const inFlightClaims = new Set<string>();

async function withClaimLock(
  h: HandlerCtx,
  ctx: Context,
  claimId: string,
  task: () => Promise<void>,
): Promise<void> {
  if (inFlightClaims.has(claimId)) {
    await answer(ctx, await h.say('hold_on'));
    return;
  }
  inFlightClaims.add(claimId);
  try {
    await task();
  } finally {
    inFlightClaims.delete(claimId);
  }
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

/** Copy key for each way a quote can fail — three situations, three messages. */
function quoteFailureCopyKey(kind: 'transient' | 'no_odds' | 'unpriceable'): TemplateKey {
  switch (kind) {
    case 'transient':
      return 'no_price';
    case 'no_odds':
      return 'no_line';
    case 'unpriceable':
      return 'unpriceable';
  }
}

/**
 * When this group is mid-replay of the claim's fixture, the replay's virtual
 * clock — so pricing pins the point-in-time odds book instead of the empty
 * post-match live snapshot. Undefined for live claims (latest book).
 */
function replayAsOfMs(h: HandlerCtx, groupId: number, fixtureId: number): number | undefined {
  if (h.supervisor.replayFixture(groupId) !== fixtureId) return undefined;
  return h.supervisor.replayAsOf(fixtureId) ?? undefined;
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
  const outcome = await quoteSpec(
    h.deps,
    option.spec,
    replayAsOfMs(h, claim.group_id, option.spec.fixtureId),
  );
  if (outcome.kind !== 'ok') {
    // Pricing failed — but the claim is NOT dead. Keep it in its current
    // pickable status (the keyboard the user is looking at stays live),
    // extend the TTL, and hand them a retry button that re-quotes the SAME
    // stored spec with no fresh LLM parse. The envelope is left untouched so
    // any previously confirmed-gate quote stays consistent with its spec.
    await h.deps.db.updateClaim(claim.id, { expires_at: extendedClaimExpiry(h) });
    const retryCanHelp = outcome.kind !== 'unpriceable';
    h.poster.post(claim.group_id, await h.say(quoteFailureCopyKey(outcome.kind)), {
      replyToMessageId: claim.tg_message_id,
      ...(retryCanHelp ? { keyboard: retryQuoteKeyboard(claim.id, optionKey) } : {}),
    });
    return;
  }
  const quote = outcome.quote;
  if (isDegenerateQuote(quote.probability)) {
    // 0% or 100% — the claim is already decided (or impossible as stated).
    // No gate: minting would sell unwinnable backs or guaranteed-loss doubts.
    // The options keyboard stays live so the user can pick another line.
    await h.deps.db.updateClaim(claim.id, { expires_at: extendedClaimExpiry(h) });
    h.poster.post(claim.group_id, await h.say('already_decided'), {
      replyToMessageId: claim.tg_message_id,
    });
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
  await h.deps.db.updateClaim(claim.id, {
    status: 'awaiting_confirm',
    parse: updated,
    expires_at: extendedClaimExpiry(h),
  });
  // A superseded gate's confirm button would mint the NEW terms while
  // displaying the old ones — strip its keyboard before posting the new gate.
  if (envelope.gateMessageId !== undefined) {
    h.poster.stripKeyboard(claim.group_id, envelope.gateMessageId);
  }
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
    onSent: async (messageId) => {
      // Read-merge-write: the envelope may have advanced while this send sat
      // in the queue — only claim the gate-message pointer.
      const fresh = await h.deps.db.getClaim(claim.id);
      const freshEnvelope = fresh ? readEnvelope(fresh) : null;
      if (!freshEnvelope) return;
      const withGate: ParseEnvelope = { ...freshEnvelope, gateMessageId: messageId };
      await h.deps.db.updateClaim(claim.id, { parse: withGate });
    },
  });
}

async function handleProve(h: HandlerCtx, ctx: Context, claimId: string): Promise<void> {
  const loaded = await loadClaimForChat(h, ctx, claimId);
  if (!loaded) {
    await stale(h, ctx);
    return;
  }
  const { claim, group } = loaded;
  if (
    (claim.status !== 'nudged' && claim.status !== 'detected') ||
    claimIsExpired(claim, h.deps.now())
  ) {
    await stale(h, ctx);
    return;
  }
  // The prove parse is a full LLM call — meter it like the passive path.
  if (!h.budget.allow(group.id)) {
    h.deps.log.info('llm_budget_exhausted', { groupId: group.id, claimId: claim.id });
    await answer(ctx, await h.say('budget_spent'));
    return;
  }
  await answer(ctx, await h.say('prove_ack'));
  // Move off 'nudged' while the parse runs (the claim lock already serializes
  // in-process taps) and extend the TTL — the user is actively engaging.
  await h.deps.db.updateClaim(claim.id, {
    status: 'clarifying',
    expires_at: extendedClaimExpiry(h),
  });

  const outcome = await proveClaim(h.deps, claim);
  if (outcome.kind === 'retryable') {
    // Infrastructure blinked — restore the prove button as a real retry
    // instead of stranding the claim in 'clarifying' with no envelope.
    await h.deps.db.updateClaim(claim.id, { status: 'nudged' });
    h.poster.post(claim.group_id, await h.say('prove_retry'), {
      replyToMessageId: claim.tg_message_id,
    });
    return;
  }
  if (outcome.kind === 'reject') {
    await h.deps.db.updateClaim(claim.id, { status: 'declined' });
    h.poster.post(claim.group_id, await h.say('reject', { message: outcome.message }), {
      replyToMessageId: claim.tg_message_id,
    });
    return;
  }
  try {
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
  } catch (err) {
    // Best-effort un-strand: put the prove button back in play, then let the
    // catch-all answer with retry copy.
    await h.deps.db.updateClaim(claim.id, { status: 'nudged' }).catch(() => undefined);
    throw err;
  }
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
  if (!fixture) {
    // A fixture-lookup miss is transient (cache mid-sync, DB blip) — never a
    // reason to permanently expire an otherwise-valid claim.
    await answer(ctx, await h.say('hiccup'));
    return;
  }
  const window = checkMintWindow(spec, fixture, h.deps.now());
  if (!window.open) {
    await h.deps.db.updateClaim(claim.id, { status: 'expired' });
    await answer(ctx, await h.say('window_closed'));
    return;
  }

  // Belt-and-braces against duplicate mints (e.g. a crash between the market
  // insert and the status flip on a previous confirm): one market per claim.
  const openMarkets = await h.deps.db.openMarketsForGroup(group.id);
  if (openMarkets.some((market) => market.claim_id === claim.id)) {
    await h.deps.db.updateClaim(claim.id, { status: 'confirmed' });
    await stale(h, ctx);
    return;
  }

  // Re-price at the confirm moment; fall back to the gate quote if odds blink.
  const freshOutcome = await quoteSpec(h.deps, spec, replayAsOfMs(h, claim.group_id, spec.fixtureId));
  const quote =
    freshOutcome.kind === 'ok'
      ? {
          probability: freshOutcome.quote.probability,
          multiplier: freshOutcome.quote.multiplier,
          provenance: freshOutcome.quote.provenance,
          oddsMessageId: freshOutcome.quote.oddsMessageId,
          oddsTsMs: freshOutcome.quote.oddsTsMs,
        }
      : storedQuote;

  // A degenerate quote (0%/100%) means the claim got decided between gate and
  // confirm (goals happen) — refuse the mint rather than fall back to the
  // stale gate price, which would hand free Rep to one side.
  if (isDegenerateQuote(quote.probability)) {
    await h.deps.db.updateClaim(claim.id, { status: 'expired' });
    if (envelope.gateMessageId !== undefined) {
      h.poster.stripKeyboard(claim.group_id, envelope.gateMessageId);
    }
    await answer(ctx, await h.say('already_decided'));
    return;
  }

  // The re-quote took real network time — make sure nothing (e.g. the cron
  // TTL sweeper) moved the claim out of 'awaiting_confirm' underneath us.
  const recheck = await h.deps.db.getClaim(claim.id);
  if (!recheck || recheck.status !== 'awaiting_confirm') {
    await stale(h, ctx);
    return;
  }

  const isReplay = h.supervisor.replayFixture(group.id) === spec.fixtureId;
  const market = await createMarketFromClaim(h.deps, {
    claim,
    group,
    spec,
    quote,
    isReplay,
    fixture,
  });
  // Ack only once the mint actually happened (no false-positive "Locked").
  await answer(ctx, 'Locked. 🎙');
  // The gate did its job — retire its buttons.
  if (envelope.gateMessageId !== undefined) {
    h.poster.stripKeyboard(claim.group_id, envelope.gateMessageId);
  }

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
  const envelope = readEnvelope(claim);
  if (envelope?.gateMessageId !== undefined) {
    h.poster.stripKeyboard(claim.group_id, envelope.gateMessageId);
  }
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
  const stakeAmount = TUNABLES.PRESET_STAKES[action.presetIndex];
  if (stakeAmount === undefined) {
    await stale(h, ctx);
    return;
  }
  // All guards + the per-(market,user) lock live in executeStake — shared with
  // the engine HTTP API so buttons and the concierge cannot diverge.
  const outcome = await executeStake(h.deps, {
    groupId: chatId,
    marketId: action.marketId,
    user: { id: from.id, displayName: displayName(from), username: from.username ?? null },
    side: action.side,
    amount: stakeAmount,
  });
  switch (outcome.kind) {
    case 'busy':
      await answer(ctx, await h.say('hold_on'));
      return;
    case 'unavailable':
    case 'duplicate': // unreachable on the button path (no idempotency key)
      await stale(h, ctx);
      return;
    case 'closed':
      await answer(ctx, `${statusLine(outcome.status)}.`);
      return;
    case 'rejected':
      await answer(ctx, await h.say(outcome.copyKey, outcome.vars));
      return;
    case 'ok':
      break;
  }
  await answer(
    ctx,
    await h.say('stake_locked', {
      name: displayName(from),
      side: action.side === 'back' ? 'Backing' : 'Doubting',
      stake: stakeAmount,
      multiplier: multiplierBare(outcome.lockedMultiplier),
    }),
  );
  // Refresh the card tally (collapsed per tunables).
  const fresh = await h.deps.db.getMarket(action.marketId);
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

/**
 * Exported for tests: routes one decoded action through the per-claim lock.
 * Claim-lifecycle taps (prove/option/confirm/decline) share the lock so a
 * double-tap — or two different taps on the same claim — can never interleave.
 */
export async function dispatchCallback(
  h: HandlerCtx,
  ctx: Context,
  action: CallbackAction,
): Promise<void> {
  switch (action.t) {
    case 'prove':
      await withClaimLock(h, ctx, action.claimId, () => handleProve(h, ctx, action.claimId));
      break;
    case 'option':
      await withClaimLock(h, ctx, action.claimId, () =>
        handleOption(h, ctx, action.claimId, action.key),
      );
      break;
    case 'confirm':
      await withClaimLock(h, ctx, action.claimId, () => handleConfirm(h, ctx, action.claimId));
      break;
    case 'decline':
      await withClaimLock(h, ctx, action.claimId, () => handleDecline(h, ctx, action.claimId));
      break;
    case 'stake':
      // Per-(market,user) serialization happens inside executeStake.
      await handleStake(h, ctx, action);
      break;
    case 'chattiness':
      await handleChattiness(h, ctx, action.mode);
      break;
    case 'web':
      await handleWeb(h, ctx, action.enabled);
      break;
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
      await dispatchCallback(h, ctx, action);
    } catch (err) {
      h.deps.log.error('callback_failed', { action: action.t, error: String(err) });
      // An internal error is NOT a stale button — invite the retry honestly.
      await answer(ctx, renderFallback('hiccup'));
    }
  });
}
