/**
 * Callback-query handlers — the whole loop lives on inline buttons:
 * Make him prove it → clarify / counter-offer options → That's my shout →
 * Back/Doubt stakes. Every tap resolves against DB rows via ids carried in
 * callback_data; anything unresolvable gets a deterministic in-character
 * "that ship has sailed" (PRD story 17).
 */

import { createHash } from 'node:crypto';
import type { Bot, Context } from 'grammy';
import { TUNABLES } from '@calledit/market-engine';
import type { ClaimRow, Deps, GroupRow, MarketRow } from '../ports.js';
import { decodeCallback, type CallbackAction } from './callbackData.js';
import { displayName, ensureUserSeen, isGroupAdmin, type HandlerCtx } from './context.js';
import {
  marketStakeKeyboard,
  settingsKeyboard,
  stakeConfirmationKeyboard,
} from './keyboards.js';
import { describeTerms, statusLine } from './cards.js';
import { readEnvelope } from '../pipeline/claims.js';
import { mintOffer, retryOffer } from '../pipeline/offer.js';
import { voidAbandonedMarket } from '../pipeline/void.js';
import { composeClaimCard } from '../pipeline/render.js';
import { renderFallback } from './copy.js';
import {
  WAGER_TUNABLES,
  isLadderCodeAllowed,
  ladderAtomic,
  presetStakes,
} from '../wager/constants.js';
import { multiplierLabel, wagerDoubtMultiplier } from '../wager/stake.js';
import { isBetaGroupAllowed } from './beta-access.js';
import { createWagerCopy } from '../wager/copy.js';
import { STAKE_LADDER_TTL_MS, type StakeUiState } from './stake-ui-state.js';
import { editCardSurface, stakePositionsAvailable } from './stake-surface.js';
import { sideLabelFor, stakeAmountLabel } from './stake-step-cards.js';
import {
  escrowPlacementRejectionText,
  escrowSigningPrompt,
  privateEscrowUrl,
  type EscrowPlacementSessionInput,
} from './escrow-ux.js';

async function answer(ctx: Context, text: string): Promise<void> {
  try {
    await ctx.answerCallbackQuery({ text: text.slice(0, 190) });
  } catch {
    // stale query ids are expected after restarts — nothing to do
  }
}

/**
 * Modal alert for money-path FAILURES (missed wallet, closed market, rejected
 * stake, broken signing session): a toast auto-dismisses in seconds, and a
 * user who misses it has no other record that their money tap did nothing.
 * Success acks stay toasts.
 */
async function answerAlert(ctx: Context, text: string): Promise<void> {
  try {
    await ctx.answerCallbackQuery({ text: text.slice(0, 190), show_alert: true });
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

function callbackMessageId(ctx: Context): number | null {
  return ctx.callbackQuery?.message?.message_id ?? null;
}

function stripCallbackKeyboard(h: HandlerCtx, ctx: Context): void {
  const chatId = ctx.chat?.id;
  const messageId = callbackMessageId(ctx);
  if (chatId !== undefined && messageId !== null) h.poster.stripKeyboard(chatId, messageId);
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

/**
 * "Run it back" retry entry after an infrastructure blip during the parse.
 * The claim sits in 'nudged'; re-parse it and route to a mint / options card.
 */
async function handleProve(h: HandlerCtx, ctx: Context, claimId: string): Promise<void> {
  const loaded = await loadClaimForChat(h, ctx, claimId);
  if (!loaded) {
    await stale(h, ctx);
    return;
  }
  const { claim, group } = loaded;
  if (claim.status !== 'nudged' || claimIsExpired(claim, h.deps.now())) {
    await stale(h, ctx);
    return;
  }
  // The parse is a full LLM call — meter it like the passive path.
  if (!h.budget.allow(group.id)) {
    h.deps.log.info('llm_budget_exhausted', { claimId: claim.id });
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
  await retryOffer(h, claim, group);
}

/** Owner-only confirmation of a passive or friend-triggered claim. */
async function handleConfirm(h: HandlerCtx, ctx: Context, claimId: string): Promise<void> {
  const loaded = await loadClaimForChat(h, ctx, claimId);
  if (!loaded) {
    await stale(h, ctx);
    return;
  }
  const { claim, group } = loaded;
  if (claim.status !== 'awaiting_confirm') {
    await stale(h, ctx);
    return;
  }
  if (ctx.from?.id !== claim.claimer_user_id) {
    const claimer = await h.deps.db.getUser(claim.claimer_user_id);
    await answer(
      ctx,
      await h.say('not_your_shout', { claimer: claimer?.display_name ?? 'the author' }),
    );
    return;
  }
  if (claimIsExpired(claim, h.deps.now())) {
    await h.deps.db.updateClaim(claim.id, { status: 'expired' });
    stripCallbackKeyboard(h, ctx);
    await stale(h, ctx);
    return;
  }
  if (!h.budget.allow(group.id)) {
    h.deps.log.info('llm_budget_exhausted', { claimId: claim.id });
    await answer(ctx, await h.say('budget_spent'));
    return;
  }
  await answer(ctx, await h.say('prove_ack'));
  await h.deps.db.updateClaim(claim.id, {
    status: 'clarifying',
    expires_at: extendedClaimExpiry(h),
  });
  stripCallbackKeyboard(h, ctx);
  await retryOffer(h, claim, group);
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
  const { claim, group } = loaded;
  if (claim.status !== 'clarifying' || claimIsExpired(claim, h.deps.now())) {
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
  await answer(ctx, 'Locking it in…');
  await mintOffer(h, claim, group, envelope, optionKey);
}

/**
 * The claimer's "Not mine" out. Before anyone bets, decline just kills the
 * claim/offer. After a market is minted, decline is only allowed while no SOL
 * is on the line — then it voids the market (refunding nothing, since nothing
 * was staked). Once a bet lands, the offer belongs to the group, not the claimer.
 */
async function handleDecline(h: HandlerCtx, ctx: Context, claimId: string): Promise<void> {
  const loaded = await loadClaimForChat(h, ctx, claimId);
  if (!loaded) {
    await stale(h, ctx);
    return;
  }
  const { claim } = loaded;
  if (ctx.from?.id !== claim.claimer_user_id) {
    const claimer = await h.deps.db.getUser(claim.claimer_user_id);
    await answer(
      ctx,
      await h.say('not_your_shout', { claimer: claimer?.display_name ?? 'the claimer' }),
    );
    return;
  }

  if (claim.status === 'awaiting_confirm' && claimIsExpired(claim, h.deps.now())) {
    await h.deps.db.updateClaim(claim.id, { status: 'expired' });
    stripCallbackKeyboard(h, ctx);
    await stale(h, ctx);
    return;
  }

  // Post-mint decline: only if nobody has bet yet — then void the market.
  if (claim.status === 'confirmed') {
    const openMarkets = await h.deps.db.openMarketsForGroup(claim.group_id);
    const market = openMarkets.find((m) => m.claim_id === claim.id);
    if (!market) {
      await stale(h, ctx);
      return;
    }
    const positions = await h.deps.db.positionsForMarket(market.id);
    const anyBets = positions.some((position) => position.state !== 'void');
    if (anyBets) {
      await answer(ctx, await h.say('offer_taken'));
      return;
    }
    if (h.deps.env.WAGER_CUSTODY_MODE === 'escrow') {
      stripCallbackKeyboard(h, ctx);
      await refreshStakeCard(h, market.group_id, market.id, { forceLocked: true });
      await answer(ctx, await h.say('escrow_void_pending_finality'));
      return;
    }
    await voidAbandonedMarket(h.deps, market);
    await answer(ctx, await h.say('confirm_declined'));
    return;
  }

  // Pre-mint decline: kill the claim before any offer card exists.
  const declinable: ClaimRow['status'][] = ['awaiting_confirm', 'nudged', 'detected', 'clarifying'];
  if (!declinable.includes(claim.status)) {
    await stale(h, ctx);
    return;
  }
  await h.deps.db.updateClaim(claim.id, { status: 'declined' });
  if (claim.status === 'awaiting_confirm') stripCallbackKeyboard(h, ctx);
  await answer(ctx, await h.say('confirm_declined'));
}

/** Re-render the market card tally after a placed tap (collapsed per tunables). */
async function refreshStakeCard(
  h: HandlerCtx,
  chatId: number,
  marketId: string,
  options: { readonly forceLocked?: boolean } = {},
): Promise<void> {
  const fresh = await h.deps.db.getMarket(marketId);
  if (fresh && fresh.card_tg_message_id !== null) {
    const currency = fresh.currency === 'usdc' ? 'usdc' : 'sol';
    const positionsAvailable = !options.forceLocked && (fresh.is_replay
      || (h.deps.wager !== null && await h.deps.wager.stakesAvailable(currency)));
    const displayed = options.forceLocked ? { ...fresh, status: 'frozen' as const } : fresh;
    const card = await composeClaimCard(h.deps, displayed, { positionsAvailable });
    if (card && card.messageId !== null) {
      h.poster.editCard(
        chatId,
        fresh.id,
        card.messageId,
        card.text,
        positionsAvailable ? marketStakeKeyboard(h.deps, displayed) : undefined,
      );
    }
  }
}

const replayStakeLocks = new Set<string>();

async function handleReplayStake(
  h: HandlerCtx,
  ctx: Context,
  market: MarketRow,
  userId: number,
  side: 'back' | 'doubt',
  lamports: bigint,
  inPlay: boolean,
): Promise<void> {
  const key = `${market.id}:${userId}`;
  if (replayStakeLocks.has(key)) {
    await answer(ctx, await h.say('hold_on'));
    return;
  }
  replayStakeLocks.add(key);
  try {
    const placeReplayPosition = h.deps.db.placeReplayPosition;
    if (placeReplayPosition === undefined) {
      h.deps.log.warn('replay_position_unavailable', { marketId: market.id });
      await answerAlert(ctx, await h.say('hiccup'));
      return;
    }
    const multiplier = side === 'back'
      ? market.quote_multiplier
      : wagerDoubtMultiplier(market.quote_probability);
    const result = await placeReplayPosition.call(h.deps.db, {
      group_id: market.group_id,
      market_id: market.id,
      user_id: userId,
      side,
      stake: Number(lamports),
      locked_multiplier: multiplier,
      locked_odds_message_id: market.odds_message_id,
      locked_odds_ts: market.odds_ts,
      state: inPlay ? 'pending' : 'active',
      placed_at_ms: h.deps.now(),
    });
    if (!result.ok) {
      await answerAlert(ctx, await h.say(result.code === 'closed' ? 'window_closed' : 'stale'));
      return;
    }
    if (result.duplicate) {
      await answerAlert(ctx, await h.say('replay_position_exists'));
      return;
    }
    h.deps.log.info('replay_position_placed', { marketId: market.id, side });
    await answer(ctx, await h.say('replay_position_recorded'));
    await refreshStakeCard(h, market.group_id, market.id);
  } catch {
    h.deps.log.warn('replay_position_failed', { marketId: market.id });
    await answerAlert(ctx, await h.say('hiccup'));
  } finally {
    replayStakeLocks.delete(key);
  }
}

function escrowPlacementIdempotencyKey(callbackId: string): string {
  return createHash('sha256')
    .update(`telegram:escrow-position:${callbackId}`)
    .digest('hex');
}

async function handleEscrowStake(
  h: HandlerCtx,
  ctx: Context,
  input: Omit<EscrowPlacementSessionInput, 'idempotencyKey'> & {
    readonly callbackId: string;
  },
): Promise<void> {
  const escrow = h.escrow;
  if (escrow === undefined) {
    await answerAlert(ctx, escrowPlacementRejectionText('temporarily_unavailable'));
    return;
  }
  const result = await escrow.createPlacementSession({
    telegramUserId: input.telegramUserId,
    groupId: input.groupId,
    marketId: input.marketId,
    side: input.side,
    asset: input.asset,
    amountAtomic: input.amountAtomic,
    network: input.network,
    replay: input.replay,
    idempotencyKey: escrowPlacementIdempotencyKey(input.callbackId),
  });
  if (result.kind === 'rejected') {
    h.deps.log.info('escrow_signing_session_rejected', {
      code: result.code,
      asset: input.asset,
    });
    if (result.code === 'market_closed') {
      await refreshStakeCard(h, input.groupId, input.marketId, { forceLocked: true });
    }
    await answerAlert(ctx, escrowPlacementRejectionText(result.code));
    return;
  }
  const url = privateEscrowUrl(h.deps.env.WEB_BASE_URL, 'position', result.token);
  const expiresAtMs = Date.parse(result.expiresAt);
  if (url === null || !Number.isFinite(expiresAtMs) || expiresAtMs <= h.deps.now()) {
    await answerAlert(ctx, escrowPlacementRejectionText('callback_expired'));
    return;
  }
  const prompt = escrowSigningPrompt({
    network: h.deps.env.SOLANA_NETWORK,
    side: input.side,
    asset: input.asset,
    amountAtomic: input.amountAtomic,
    expiresAt: result.expiresAt,
    replay: input.replay,
  });
  try {
    await ctx.api.sendMessage(input.telegramUserId, prompt, {
      reply_markup: {
        inline_keyboard: [[{ text: 'Review and sign', web_app: { url } }]],
      },
    });
  } catch (error) {
    h.deps.log.warn('escrow_private_link_delivery_failed', {
      reason: error instanceof Error ? 'telegram_api_exception' : 'unknown_exception',
    });
    await answerAlert(ctx, 'Open my private chat, run /wallet, then tap your choice again. No assets moved.');
    return;
  }
  h.deps.log.info('escrow_signing_link_issued', {
    asset: input.asset,
    side: input.side,
    duplicate: result.duplicate,
  });
  await answer(ctx, result.duplicate
    ? 'Your existing private signing link was sent again.'
    : 'Private signing link sent. The group updates only after finalization.');
}

/**
 * The shared guard chain for a side/value tap — everything from identity and
 * market load through the in-play snipe cutoff, up to (but not including) the
 * money dispatch. `lamportsFor` resolves the tap's amount from the narrowed
 * asset; returning null aborts as a stale tap. Answers ctx and returns null on
 * any gate, so callers just early-return.
 */
interface ResolvedStake {
  readonly chatId: number;
  readonly from: NonNullable<Context['from']>;
  readonly wager: Deps['wager'];
  readonly escrowMode: boolean;
  readonly market: MarketRow;
  readonly wagerMarket: MarketRow & { currency: 'sol' | 'usdc' };
  readonly asset: 'sol' | 'usdc';
  readonly lamports: bigint;
  readonly callbackId: string;
  readonly inPlay: boolean;
}

async function resolveStake(
  h: HandlerCtx,
  ctx: Context,
  marketId: string,
  lamportsFor: (asset: 'sol' | 'usdc', escrowMode: boolean, wager: Deps['wager']) => bigint | null,
): Promise<ResolvedStake | null> {
  const chatId = ctx.chat?.id;
  const from = ctx.from;
  const wager = h.deps.wager;
  const escrowMode = h.deps.env.WAGER_CUSTODY_MODE === 'escrow';
  if (chatId === undefined || !from || (!escrowMode && !wager)) {
    await stale(h, ctx);
    return null;
  }
  const market: MarketRow | null = await h.deps.db.getMarket(marketId);
  if (
    !market || market.group_id !== chatId
    || (market.currency !== 'sol' && market.currency !== 'usdc')
  ) {
    await stale(h, ctx);
    return null;
  }
  const asset = market.currency;
  const wagerMarket = { ...market, currency: asset };
  if (market.status !== 'open' && market.status !== 'pending_lineup') {
    await answerAlert(ctx, `${statusLine(market.status)}.`);
    return null;
  }
  if (market.is_replay) {
    const admission = await h.supervisor.admitReplayPosition(market);
    if (admission.kind === 'stale') {
      await refreshStakeCard(h, chatId, market.id, { forceLocked: true });
      await answerAlert(ctx, 'That test call is no longer active. No assets moved.');
      return null;
    }
  }
  const lamports = lamportsFor(asset, escrowMode, wager);
  if (lamports === null) {
    await stale(h, ctx);
    return null;
  }
  const callbackId = ctx.callbackQuery?.id;
  if (callbackId === undefined) {
    await stale(h, ctx);
    return null;
  }
  // In-play cutoff — no new positions once a match is deep enough that a tap
  // would be a near-certain snipe.
  const replayFixture = market.is_replay
    ? h.supervisor.replaySnapshot(chatId)
    : null;
  const fixture = replayFixture?.fixture_id === market.fixture_id
    ? replayFixture
    : await h.deps.db.getFixture(market.fixture_id);
  const inPlay = fixture !== null && fixture.phase !== 'NS';
  if (inPlay && fixture.minute !== null && fixture.minute >= TUNABLES.INPLAY_STAKE_CUTOFF_MINUTE) {
    await answerAlert(ctx, await h.say('window_closed'));
    return null;
  }
  return { chatId, from, wager, escrowMode, market, wagerMarket, asset, lamports, callbackId, inPlay };
}

/**
 * The non-escrow money dispatch (funded replay / replay / mainnet confirm /
 * direct SOL stake). Byte-for-byte the single-tap tail; shared by the two-step
 * value tap so the money path never forks. Returns whether the stake committed.
 */
async function commitLegacyStake(
  h: HandlerCtx,
  ctx: Context,
  r: ResolvedStake,
  side: 'back' | 'doubt',
): Promise<{ committed: boolean }> {
  const { chatId, from, market, wagerMarket, asset, lamports, callbackId, inPlay, wager } = r;
  if (wager === null) {
    await stale(h, ctx);
    return { committed: false };
  }
  const fundedReplay = market.is_replay
    && wager.kind === 'funded'
    && h.deps.env.SOLANA_NETWORK === 'mainnet-beta';
  if (market.is_replay && !fundedReplay) {
    await handleReplayStake(h, ctx, market, from.id, side, lamports, inPlay);
    return { committed: true };
  }
  if (h.deps.env.SOLANA_NETWORK === 'mainnet-beta' && wager.kind === 'funded') {
    const prepared = await wager.prepareStakeConfirmation({
      market: wagerMarket,
      userId: from.id,
      userName: displayName(from),
      side,
      lamports,
      inPlay,
      nowMs: h.deps.now(),
      callbackId,
    });
    if (!prepared.ok) {
      await answerAlert(ctx, prepared.reply);
      if (!(await wager.stakesAvailable(asset))) {
        await refreshStakeCard(h, chatId, market.id);
      }
      return { committed: false };
    }
    const multiplier = side === 'back'
      ? market.quote_multiplier
      : wagerDoubtMultiplier(market.quote_probability);
    const copy = createWagerCopy('mainnet-beta', asset);
    const sourceMessageId = callbackMessageId(ctx);
    h.poster.post(chatId, copy.confirmationPrompt(
      displayName(from),
      side === 'back' ? 'It happens' : 'It does not',
      lamports,
      multiplierLabel(multiplier),
      describeTerms(market.spec),
    ), {
      ...(sourceMessageId !== null ? { replyToMessageId: sourceMessageId } : {}),
      keyboard: stakeConfirmationKeyboard(prepared.intentId),
    });
    await answer(ctx, copy.confirmationSent());
    return { committed: true };
  }
  const result = await wager.handleStakeTap({
    market: wagerMarket,
    userId: from.id,
    userName: displayName(from),
    side,
    lamports,
    inPlay,
    nowMs: h.deps.now(),
    source:
      asset === 'sol'
      && lamports === WAGER_TUNABLES.PRESET_STAKES_LAMPORTS[0] &&
      h.deps.env.STARTER_GRANTS_ENABLED && h.deps.env.STAKE_ACCEPTANCE_ENABLED
        ? { kind: 'telegram_default_card', callbackId }
        : { kind: 'telegram_card', callbackId },
  });
  // accepted covers placed and idempotent replays; anything else is a
  // rejection the tapper must not miss.
  if (result.accepted === true) {
    await answer(ctx, result.reply);
  } else {
    await answerAlert(ctx, result.reply);
  }
  if (result.placed || !(await wager.stakesAvailable(asset))) {
    await refreshStakeCard(h, chatId, market.id);
  }
  return { committed: result.placed === true };
}

/**
 * A Back / Against tap (step 1). With the ladder flag OFF this is the whole
 * single-tap flow: resolve the default preset to lamports and dispatch straight
 * to escrow signing or the wager module. With the flag ON it mints nothing —
 * it opens the value ladder on the card (see handleLadderEntry).
 */
async function handleStake(
  h: HandlerCtx,
  ctx: Context,
  action: Extract<CallbackAction, { t: 'stake' }>,
): Promise<void> {
  if (h.deps.env.STAKE_LADDER_ENABLED && h.uiState !== undefined) {
    await handleLadderEntry(h, ctx, action.marketId, action.side);
    return;
  }
  const r = await resolveStake(h, ctx, action.marketId, (asset, escrowMode, wager) =>
    escrowMode
      ? presetStakes(asset)[action.presetIndex] ?? null
      : wager?.presetLamports(action.presetIndex, asset) ?? null,
  );
  if (r === null) return;
  await ensureUserSeen(h, r.chatId, r.from);
  if (r.escrowMode) {
    await handleEscrowStake(h, ctx, {
      callbackId: r.callbackId,
      telegramUserId: r.from.id,
      groupId: r.chatId,
      marketId: r.market.id,
      side: action.side,
      asset: r.asset,
      amountAtomic: r.lamports,
      network: h.deps.env.SOLANA_NETWORK,
      replay: r.market.is_replay,
    });
    return;
  }
  await commitLegacyStake(h, ctx, r, action.side);
}

/**
 * Load and guard a market for the stepper: it must belong to this chat, be an
 * asset market, be open for positions, and not be paused. Answers ctx and
 * returns null on any gate so callers early-return. Never mutates ui state.
 */
async function loadStepperMarket(
  h: HandlerCtx,
  ctx: Context,
  marketId: string,
): Promise<MarketRow | null> {
  const chatId = ctx.chat?.id;
  if (h.uiState === undefined || chatId === undefined) {
    await stale(h, ctx);
    return null;
  }
  const market = await h.deps.db.getMarket(marketId);
  if (
    !market || market.group_id !== chatId
    || (market.currency !== 'sol' && market.currency !== 'usdc')
  ) {
    await stale(h, ctx);
    return null;
  }
  if (market.status !== 'open' && market.status !== 'pending_lineup') {
    await answerAlert(ctx, `${statusLine(market.status)}.`);
    return null;
  }
  if (!(await stakePositionsAvailable(h.deps, market))) {
    // Positions paused — keep the card honest instead of showing a dead stepper.
    await refreshStakeCard(h, market.group_id, market.id);
    await answerAlert(ctx, 'New positions are paused right now. No SOL moved.');
    return null;
  }
  return market;
}

/** Set the stepper state at `code` and urgent-edit the card to match. */
async function renderStepper(
  h: HandlerCtx,
  market: MarketRow,
  side: 'back' | 'doubt',
  code: StakeUiState['code'],
): Promise<void> {
  const uiState: StakeUiState = { kind: 'ladder', side, code };
  h.uiState?.set(market.id, uiState, STAKE_LADDER_TTL_MS);
  await editCardSurface(
    h.deps,
    h.poster,
    market,
    { positionsAvailable: true, ladderEnabled: true, uiState },
    { urgent: true },
  );
}

/** Clear the stepper and urgent-edit the card back to the two-side offer. */
async function revertToOffer(h: HandlerCtx, market: MarketRow): Promise<void> {
  h.uiState?.clear(market.id);
  await editCardSurface(
    h.deps,
    h.poster,
    market,
    {
      positionsAvailable: await stakePositionsAvailable(h.deps, market),
      ladderEnabled: true,
      uiState: null,
    },
    { urgent: true },
  );
}

/**
 * Step 1 with the stepper ON: the side tap moves ZERO SOL. It opens the stepper
 * at the anchor rung (0.01, code 1 — never a higher preselection) in the shared
 * in-process store (20s auto-revert) and urgent-edits the card. Reversible via
 * "← Back" until the explicit sign/confirm.
 */
async function handleLadderEntry(
  h: HandlerCtx,
  ctx: Context,
  marketId: string,
  side: 'back' | 'doubt',
): Promise<void> {
  const market = await loadStepperMarket(h, ctx, marketId);
  if (market === null) return;
  await renderStepper(h, market, side, 1);
  await answer(ctx, `${sideLabelFor(market.spec, side)} — now size it below.`);
}

/**
 * A ± tap (or the middle amount tap) on the stepper. Moves ZERO SOL: it dials
 * the current rung to the tapped code and re-renders the same card. Requires an
 * active stepper for this side; an expired one lazily reverts to the offer so
 * the shared surface never sticks. The commit is the separate sign/confirm.
 */
async function handleStakeStep(
  h: HandlerCtx,
  ctx: Context,
  action: Extract<CallbackAction, { t: 'stake_step' }>,
): Promise<void> {
  const store = h.uiState;
  if (!h.deps.env.STAKE_LADDER_ENABLED || store === undefined) {
    await stale(h, ctx);
    return;
  }
  const market = await loadStepperMarket(h, ctx, action.marketId);
  if (market === null) return;
  const asset = market.currency === 'usdc' ? 'usdc' : 'sol';
  const custody = h.deps.env.WAGER_CUSTODY_MODE;
  const network = h.deps.env.SOLANA_NETWORK;
  if (!isLadderCodeAllowed(action.amountCode, asset, custody, network)) {
    // A forged or over-cap rung — never render it, never move SOL.
    await stale(h, ctx);
    return;
  }
  const current = store.get(market.id);
  if (current === null || current.side !== action.side) {
    // The sizing window closed (or this is a stale button from another side):
    // revert to the offer rather than resurrect a stepper nobody is holding.
    await revertToOffer(h, market);
    await answer(ctx, 'That sizing step closed — tap a side to size again.');
    return;
  }
  const amountLabel = stakeAmountLabel(ladderAtomic(asset, action.amountCode), asset);
  if (current.code === action.amountCode) {
    // The middle amount tap (or a re-tap of the same rung): keep the surface
    // alive without a redundant edit.
    store.set(market.id, current, STAKE_LADDER_TTL_MS);
    await answer(ctx, `Sizing ${amountLabel}.`);
    return;
  }
  await renderStepper(h, market, action.side, action.amountCode);
  await answer(ctx, `Sizing ${amountLabel}.`);
}

/**
 * The explicit commit at the stepper's current rung (stepper ON). Reuses the
 * full stake guard chain, then for escrow issues the private DM signing link
 * (the fallback when the in-card Mini App URL is unavailable), and for legacy
 * commits the stake at the shown amount exactly like the single tap. The card
 * returns to the two-side offer either way.
 */
async function handleStakeValue(
  h: HandlerCtx,
  ctx: Context,
  action: Extract<CallbackAction, { t: 'stake_value' }>,
): Promise<void> {
  const store = h.uiState;
  if (!h.deps.env.STAKE_LADDER_ENABLED || store === undefined) {
    await stale(h, ctx);
    return;
  }
  const custody = h.deps.env.WAGER_CUSTODY_MODE;
  const network = h.deps.env.SOLANA_NETWORK;
  const r = await resolveStake(h, ctx, action.marketId, (asset) =>
    isLadderCodeAllowed(action.amountCode, asset, custody, network)
      ? ladderAtomic(asset, action.amountCode)
      : null,
  );
  if (r === null) return;
  await ensureUserSeen(h, r.chatId, r.from);
  if (r.escrowMode) {
    // Escrow signs in the Mini App; this callback is only reached when the
    // in-card URL was unavailable, so fall back to the private DM signing link.
    await handleEscrowStake(h, ctx, {
      callbackId: r.callbackId,
      telegramUserId: r.from.id,
      groupId: r.chatId,
      marketId: r.market.id,
      side: action.side,
      asset: r.asset,
      amountAtomic: r.lamports,
      network: h.deps.env.SOLANA_NETWORK,
      replay: r.market.is_replay,
    });
    await revertToOffer(h, r.market);
    return;
  }
  // Legacy: the confirm tap IS the commit.
  await commitLegacyStake(h, ctx, r, action.side);
  // Return the card to the two-side offer immediately (updated tallies), rather
  // than leaving the stepper visible until the next passive refresh collapses.
  await revertToOffer(h, r.market);
}

/** "← Back" from the stepper to the two-side offer. Loses nothing. */
async function handleStakeBack(h: HandlerCtx, ctx: Context, marketId: string): Promise<void> {
  const store = h.uiState;
  const chatId = ctx.chat?.id;
  if (!h.deps.env.STAKE_LADDER_ENABLED || store === undefined || chatId === undefined) {
    await stale(h, ctx);
    return;
  }
  const market = await h.deps.db.getMarket(marketId);
  if (!market || market.group_id !== chatId) {
    await stale(h, ctx);
    return;
  }
  await revertToOffer(h, market);
  await answer(ctx, 'Back to the call.');
}

async function finishStakeConfirmationMessage(ctx: Context, text: string): Promise<void> {
  try {
    await ctx.editMessageText(text, { reply_markup: { inline_keyboard: [] } });
  } catch {
    // The callback answer still carries the result if the prompt is too old to edit.
  }
}

async function handleStakeConfirmation(
  h: HandlerCtx,
  ctx: Context,
  intentId: string,
  confirm: boolean,
): Promise<void> {
  const from = ctx.from;
  const wager = h.deps.wager;
  if (!from || wager?.kind !== 'funded') {
    await stale(h, ctx);
    return;
  }
  const intent = await wager.getStakeConfirmation(from.id, intentId);
  const copy = createWagerCopy(h.deps.env.SOLANA_NETWORK, intent?.asset ?? 'sol');
  if (intent === null || ctx.chat?.id !== intent.groupId) {
    await answerAlert(ctx, copy.confirmationExpired());
    return;
  }
  if (!confirm) {
    await wager.cancelStakeConfirmation(from.id, intentId);
    const cancelled = copy.confirmationCancelled();
    await finishStakeConfirmationMessage(ctx, cancelled);
    await answer(ctx, cancelled);
    return;
  }
  const market = await h.deps.db.getMarket(intent.marketId);
  if (
    market === null || market.group_id !== intent.groupId || market.currency !== intent.asset
    || (market.status !== 'open' && market.status !== 'pending_lineup')
  ) {
    await wager.cancelStakeConfirmation(from.id, intentId);
    const expired = copy.confirmationExpired();
    await finishStakeConfirmationMessage(ctx, expired);
    await answerAlert(ctx, expired);
    return;
  }
  const replayFixture = market.is_replay
    ? h.supervisor.replaySnapshot(intent.groupId)
    : null;
  const fixture = replayFixture?.fixture_id === market.fixture_id
    ? replayFixture
    : await h.deps.db.getFixture(market.fixture_id);
  const inPlay = fixture !== null && fixture.phase !== 'NS';
  if (inPlay && fixture.minute !== null && fixture.minute >= TUNABLES.INPLAY_STAKE_CUTOFF_MINUTE) {
    await wager.cancelStakeConfirmation(from.id, intentId);
    const closed = await h.say('window_closed');
    await finishStakeConfirmationMessage(ctx, closed);
    await answerAlert(ctx, closed);
    return;
  }
  await ensureUserSeen(h, intent.groupId, from);
  const result = await wager.confirmStakeConfirmation({
    intentId,
    market: { ...market, currency: intent.asset },
    userId: from.id,
    userName: displayName(from),
    side: intent.side,
    lamports: intent.lamports,
    inPlay,
    nowMs: h.deps.now(),
  });
  await finishStakeConfirmationMessage(ctx, result.reply);
  // The prompt message itself was edited to the result, so the un-placed
  // outcome still needs the unmissable ack; a placed one reads fine as a toast.
  if (result.placed) {
    await answer(ctx, result.reply);
  } else {
    await answerAlert(ctx, result.reply);
  }
  await refreshStakeCard(h, intent.groupId, market.id);
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

async function handleVoidReplayBlocker(
  h: HandlerCtx,
  ctx: Context,
  marketId: string,
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

  if (h.deps.env.WAGER_CUSTODY_MODE === 'escrow') {
    await refreshStakeCard(h, chatId, marketId, { forceLocked: true });
    const locked = await h.say('escrow_void_pending_finality');
    try {
      await ctx.editMessageText(locked, { reply_markup: { inline_keyboard: [] } });
    } catch {
      stripCallbackKeyboard(h, ctx);
      h.poster.post(chatId, locked);
    }
    await answer(ctx, locked);
    return;
  }

  const result = await h.supervisor.runGroupExclusive(chatId, async () => {
    const market = await h.deps.db.getMarket(marketId);
    if (
      market === null ||
      market.group_id !== chatId ||
      market.is_replay ||
      market.status === 'settled' ||
      market.status === 'voided'
    ) return { kind: 'stale' } as const;
    const positions = await h.deps.db.positionsForMarket(market.id);
    if (positions.some((position) => position.state !== 'void')) {
      return { kind: 'has_positions' } as const;
    }
    const claim = await h.deps.db.getClaim(market.claim_id);
    await voidAbandonedMarket(h.deps, market);
    return {
      kind: 'voided',
      market,
      call: claim?.quoted_text ?? 'the blocking call',
    } as const;
  });

  if (result.kind === 'stale') {
    await stale(h, ctx);
    return;
  }
  if (result.kind === 'has_positions') {
    await answer(ctx, await h.say('offer_taken'));
    return;
  }

  const { market, call } = result;
  if (market.card_tg_message_id !== null) {
    const card = await composeClaimCard(h.deps, { ...market, status: 'voided' });
    if (card?.messageId !== null && card?.messageId !== undefined) {
      h.poster.editCard(card.chatId, market.id, card.messageId, card.text);
    }
  }
  const confirmation = await h.say('replay_blocking_call_voided', { call });
  try {
    await ctx.editMessageText(confirmation, { reply_markup: { inline_keyboard: [] } });
  } catch {
    stripCallbackKeyboard(h, ctx);
    h.poster.post(chatId, confirmation);
  }
  await answer(ctx, confirmation);
}

/**
 * Exported for tests: routes one decoded action through the per-claim lock.
 * Claim-lifecycle taps (prove/option/decline) share the lock so a double-tap —
 * or two different taps on the same claim — can never interleave.
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
      // SOL stakes are serialized by the wager module's DB advisory locks.
      await handleStake(h, ctx, action);
      break;
    case 'stake_step':
      // Zero-SOL re-size of the shared stepper surface; no money path touched.
      await handleStakeStep(h, ctx, action);
      break;
    case 'stake_value':
      // Market-scoped shared surface; the money path keeps its own DB locks.
      await handleStakeValue(h, ctx, action);
      break;
    case 'stake_back':
      await handleStakeBack(h, ctx, action.marketId);
      break;
    case 'stake_confirm':
      await handleStakeConfirmation(h, ctx, action.intentId, true);
      break;
    case 'stake_cancel':
      await handleStakeConfirmation(h, ctx, action.intentId, false);
      break;
    case 'void_replay_blocker':
      await handleVoidReplayBlocker(h, ctx, action.marketId);
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
    const chatId = ctx.chat?.id;
    if (chatId === undefined || !isBetaGroupAllowed(h.deps.env, chatId)) {
      await stale(h, ctx);
      return;
    }
    const action = decodeCallback(ctx.callbackQuery.data);
    if (!action) {
      await answer(ctx, renderFallback('stale'));
      return;
    }
    try {
      await dispatchCallback(h, ctx, action);
    } catch (err) {
      h.deps.log.error('callback_failed', { action: action.t, reason: err instanceof Error ? 'callback_exception' : 'unknown_exception' });
      // An internal error is NOT a stale button — invite the retry honestly.
      await answer(ctx, renderFallback('hiccup'));
    }
  });
}
