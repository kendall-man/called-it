/**
 * Explicit speaker intent parses, prices, and mints directly. Passive or
 * friend-triggered claims persist an owner-only confirmation gate first, so
 * neither terms nor a public quote leave the engine before the speaker agrees.
 *
 * The mint price LOCKS the FOR↔AGAINST settlement ratio (wager/pot.ts), so the
 * one-market-per-claim guard must stay inside the caller's claim lock (there is
 * no unique index on markets.claim_id).
 */

import type { User } from 'grammy/types';
import { TUNABLES } from '@calledit/market-engine';
import type { ClaimRow, Deps, FixtureRow, GroupRow, MarketRow } from '../ports.js';
import type { HandlerCtx } from '../bot/context.js';
import {
  CLAIM_EXPIRED_LINE,
  describeTerms,
  readingCardText,
  skeletonCardText,
} from '../bot/cards.js';
import { closeClaimSurface, editClaimSurface } from './claim-surface.js';
import {
  confirmKeyboard,
  marketStakeKeyboard,
  offerKeyboard,
  optionsKeyboard,
  retryParseKeyboard,
  retryQuoteKeyboard,
} from '../bot/keyboards.js';
import type { TemplateKey } from '../bot/copy.js';
import { composeTelegramMessage } from '../bot/message-budget.js';
import type { CompileContextOverrides } from './context.js';
import { composeClaimCard } from './render.js';
import { escrowMarketPositionsReady } from './escrow-market-provisioning.js';
import {
  checkMintWindow,
  createMarketFromClaim,
  isDegenerateQuote,
  proveClaim,
  quoteSpec,
  SPEAKER_CONFIRM_TTL_MS,
  type ParseEnvelope,
  type ProveOutcome,
} from './claims.js';

/**
 * The provisioning poll runs every 1.5s; Telegram clears a "typing" status
 * after ~5s, so every third poll attempt (4.5s) re-arms it just in time.
 */
const TYPING_REFRESH_POLL_ATTEMPTS = 3;

/**
 * How long the full-card step waits for the skeleton send to land before
 * falling back to posting the full card as a fresh message. Generous because
 * the send queue may be rate-limited behind a goal burst.
 */
const SKELETON_SEND_TIMEOUT_MS = 30_000;

/** The claim TTL is an inactivity deadline; every meaningful step pushes it out. */
function extendedClaimExpiry(deps: Deps): string {
  return new Date(deps.now() + TUNABLES.UNCONFIRMED_CLAIM_TTL_MS).toISOString();
}

function confirmationExpiry(deps: Deps): string {
  return new Date(deps.now() + SPEAKER_CONFIRM_TTL_MS).toISOString();
}

/** Close the authoritative pre-mint surface so an expired choice cannot be tapped again. */
async function expireMintSurface(h: HandlerCtx, claim: ClaimRow): Promise<void> {
  await h.deps.db.updateClaim(claim.id, { status: 'expired' });
  if (!closeClaimSurface(h.poster, h.claimSurface, claim, CLAIM_EXPIRED_LINE)) {
    h.poster.post(claim.group_id, await h.say('window_closed'), {
      replyToMessageId: claim.tg_message_id,
    });
  }
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
interface ReplayCompileContext extends CompileContextOverrides {
  runId: number;
  fixture: FixtureRow;
  nowMs: number;
}

function replayContext(
  h: HandlerCtx,
  groupId: number,
  fixtureId: number,
): ReplayCompileContext | undefined {
  const runId = h.supervisor.replayRunId(groupId);
  if (runId === null) return undefined;
  if (h.supervisor.replayFixture(groupId) !== fixtureId) return undefined;
  const fixture = h.supervisor.replaySnapshot(groupId);
  if (fixture?.fixture_id !== fixtureId) return undefined;
  return {
    runId,
    fixture,
    nowMs: h.supervisor.replayAsOfForGroup(groupId) ?? h.deps.now(),
  };
}

/**
 * Post the card shell the moment the market row exists so the group sees
 * progress instead of dead air during the (up to 60s) escrow provisioning
 * wait. Resolves with the persisted card message id once the send lands, or
 * null when the send fails or times out — callers then fall back to posting
 * the full card as a fresh message (the pre-skeleton behavior).
 */
async function postSkeletonCard(
  h: HandlerCtx,
  claim: ClaimRow,
  market: MarketRow,
): Promise<number | null> {
  const claimer = await h.deps.db.getUser(claim.claimer_user_id);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), SKELETON_SEND_TIMEOUT_MS);
    timer.unref();
    h.poster.post(claim.group_id, skeletonCardText({
      quotedText: claim.quoted_text,
      claimerName: claimer?.display_name ?? 'the claimer',
      isReplay: market.is_replay,
    }), {
      replyToMessageId: claim.tg_message_id,
      onSent: async (messageId) => {
        // Persist BEFORE resolving so a crash after this point finds the id
        // and a retry edits this message instead of posting a second card.
        await h.deps.db.setMarketCardMessage(market.id, messageId);
        clearTimeout(timer);
        resolve(messageId);
      },
      onSendFailed: () => {
        clearTimeout(timer);
        resolve(null);
      },
    });
  });
}

/**
 * The market card's message id. Under the single-message lifecycle
 * (STAKE_LADDER_ENABLED) it INHERITS the pre-mint surface: the consent gate /
 * reading shell / clarify options message becomes the market card, so the
 * whole claim rides one message. The market card is edited into the skeleton
 * immediately so the escrow-provisioning wait still shows progress. Without a
 * tracked surface (flag off, or the id was lost on restart) it falls back to
 * posting a fresh skeleton card, exactly as before.
 */
async function establishCardSurface(
  h: HandlerCtx,
  claim: ClaimRow,
  market: MarketRow,
): Promise<number | null> {
  const inherited = h.claimSurface === undefined
    ? undefined
    : h.claimSurface.get(claim.id) ?? claim.surface_tg_message_id ?? undefined;
  if (inherited === undefined) return postSkeletonCard(h, claim, market);
  // Persist BEFORE editing so a crash finds the id and a retry heals the same
  // message (repairExistingCard) instead of posting a second card.
  await h.deps.db.setMarketCardMessage(market.id, inherited);
  const claimer = await h.deps.db.getUser(claim.claimer_user_id);
  h.poster.editCard(
    claim.group_id,
    market.id,
    inherited,
    skeletonCardText({
      quotedText: claim.quoted_text,
      claimerName: claimer?.display_name ?? 'the claimer',
      isReplay: market.is_replay,
    }),
    undefined,
    { urgent: true },
  );
  return inherited;
}

/**
 * A retry that finds the market already minted may be recovering from a crash
 * between the skeleton post and the full-card edit — finish that edit from
 * persisted state (the settler's refresh shape) instead of leaving the card
 * stuck on "pricing". Editing an already-complete card is a Telegram no-op.
 */
async function repairExistingCard(h: HandlerCtx, market: MarketRow): Promise<void> {
  if (market.card_tg_message_id === null) return;
  const card = await composeClaimCard(h.deps, market);
  if (!card || card.messageId === null) return;
  const keyboard = market.status === 'open' || market.status === 'pending_lineup'
    ? marketStakeKeyboard(h.deps, market)
    : undefined;
  h.poster.editCard(card.chatId, market.id, card.messageId, card.text, keyboard);
}

/**
 * Price the chosen spec and, if it holds, mint the market and post the offer
 * card. Shared by the detect path (kind 'ok') and the option-pick tap. Returns
 * whether a market was minted so the tap handler can ack correctly.
 */
export async function mintOffer(
  h: HandlerCtx,
  claim: ClaimRow,
  group: GroupRow,
  envelope: ParseEnvelope,
  optionKey: string,
): Promise<{ minted: boolean }> {
  const option = envelope.options.find((candidate) => candidate.key === optionKey);
  if (!option) return { minted: false };
  const spec = option.spec;
  // Presence, not narration: the group sees work happening without a message.
  h.poster.chatAction(claim.group_id, 'typing');
  const replay = replayContext(h, claim.group_id, spec.fixtureId);

  // This quote LOCKS the settlement ratio — never mint on a failed/degenerate price.
  const outcome = await quoteSpec(h.deps, spec, replay?.nowMs, replay);
  if (outcome.kind !== 'ok') {
    await h.deps.db.updateClaim(claim.id, { expires_at: extendedClaimExpiry(h.deps) });
    const retryCanHelp = outcome.kind !== 'unpriceable';
    h.poster.post(claim.group_id, await h.say(quoteFailureCopyKey(outcome.kind)), {
      replyToMessageId: claim.tg_message_id,
      ...(retryCanHelp ? { keyboard: retryQuoteKeyboard(claim.id, optionKey) } : {}),
    });
    return { minted: false };
  }
  const quote = outcome.quote;
  if (isDegenerateQuote(quote.probability)) {
    // 0% or 100% — already decided (or impossible as stated). Minting would sell
    // an unwinnable side. Keep the claim pickable so another line can be chosen.
    await h.deps.db.updateClaim(claim.id, { expires_at: extendedClaimExpiry(h.deps) });
    h.poster.post(claim.group_id, await h.say('already_decided'), {
      replyToMessageId: claim.tg_message_id,
    });
    return { minted: false };
  }

  const fixture = replay?.fixture ?? await h.deps.db.getFixture(spec.fixtureId);
  if (!fixture) {
    // A fixture-lookup miss is transient (cache mid-sync) — offer a retry.
    await h.deps.db.updateClaim(claim.id, { expires_at: extendedClaimExpiry(h.deps) });
    h.poster.post(claim.group_id, await h.say('hiccup'), {
      replyToMessageId: claim.tg_message_id,
      keyboard: retryQuoteKeyboard(claim.id, optionKey),
    });
    return { minted: false };
  }
  const window = checkMintWindow(spec, fixture, replay?.nowMs ?? h.deps.now());
  if (!window.open) {
    await expireMintSurface(h, claim);
    return { minted: false };
  }

  // One market per claim — belt-and-braces against a double mint (crash between
  // the market insert and the status flip). Runs inside the caller's claim lock.
  const openMarkets = await h.deps.db.openMarketsForGroup(group.id);
  const existingMarket = openMarkets.find((market) => market.claim_id === claim.id);
  if (existingMarket !== undefined) {
    await h.deps.db.updateClaim(claim.id, { status: 'confirmed' });
    await repairExistingCard(h, existingMarket);
    return { minted: false };
  }

  const pricedEnvelope: ParseEnvelope = {
    ...envelope,
    chosen: spec,
    quote: {
      probability: quote.probability,
      multiplier: quote.multiplier,
      provenance: quote.provenance,
      oddsMessageId: quote.oddsMessageId,
      oddsTsMs: quote.oddsTsMs,
    },
  };
  const mintResult = await h.supervisor.runGroupExclusive(group.id, async () => {
    let mintFixture = fixture;
    if (replay !== undefined) {
      const currentReplay = replayContext(h, group.id, spec.fixtureId);
      if (currentReplay?.runId !== replay.runId) return { kind: 'closed' as const };
      if (!checkMintWindow(spec, currentReplay.fixture, currentReplay.nowMs).open) {
        return { kind: 'closed' as const };
      }
      mintFixture = currentReplay.fixture;
    } else if (h.supervisor.replayRunId(group.id) !== null) {
      return { kind: 'closed' as const };
    }

    const market = await createMarketFromClaim(h.deps, {
      claim,
      group,
      spec,
      quote: {
        probability: quote.probability,
        multiplier: quote.multiplier,
        provenance: quote.provenance,
        oddsMessageId: quote.oddsMessageId,
        oddsTsMs: quote.oddsTsMs,
      },
      isReplay: replay !== undefined,
      fixture: mintFixture,
    });
    await h.deps.db.updateClaim(claim.id, { parse: pricedEnvelope });
    // The skeleton send rides the queue without blocking the lock; the edit
    // into the full card below awaits its message id. Under the single-message
    // lifecycle this inherits the pre-mint surface instead of posting fresh.
    const skeletonMessageId = establishCardSurface(h, claim, market);
    const escrowReady = await escrowMarketPositionsReady(h.deps, market, undefined, (attempt) => {
      if (attempt % TYPING_REFRESH_POLL_ATTEMPTS === 0) {
        h.poster.chatAction(claim.group_id, 'typing');
      }
    });
    return { kind: 'minted' as const, market, escrowReady, skeletonMessageId };
  });
  if (mintResult.kind === 'closed') {
    await expireMintSurface(h, claim);
    return { minted: false };
  }
  const { market, escrowReady, skeletonMessageId } = mintResult;
  // The market card now owns the message via its durable card_tg_message_id;
  // the pre-mint surface entry is spent.
  h.claimSurface?.forget(claim.id);
  const currency = market.currency === 'usdc' ? 'usdc' : 'sol';

  const positionsAvailable = escrowReady && (
    market.is_replay
    || (h.deps.wager !== null && await h.deps.wager.stakesAvailable(currency))
  );
  const card = await composeClaimCard(h.deps, market, { positionsAvailable });
  const cardMessageId = await skeletonMessageId;
  if (!card) {
    // The claim or group row vanished mid-mint. Do not leave the shell
    // claiming it is still pricing — no positions changed, no SOL moved.
    if (cardMessageId !== null) {
      h.poster.editCard(claim.group_id, market.id, cardMessageId, await h.say('hiccup'));
    }
    return { minted: true };
  }
  const claimer = await h.deps.db.getUser(claim.claimer_user_id);
  const garnish = await h.say('offer_live', {
    claimer: claimer?.display_name ?? 'legend',
    amount: h.deps.wager?.presetLabels(currency)[0]
      ?? (currency === 'usdc' ? '1 USDC' : '0.01 SOL'),
  });
  const pendingNote = market.status === 'pending_lineup' ? await h.say('pending_lineup_note') : '';
  const fullCardText = composeTelegramMessage({
    body: card.text,
    garnish,
    note: pendingNote,
  });
  const keyboard = positionsAvailable ? offerKeyboard(market) : undefined;
  if (cardMessageId !== null) {
    // Edit the skeleton into the full offer card (or its paused/failure
    // state) — the market keeps one group surface for its whole life.
    // This is the first usable state of the same card, not a noisy market
    // refresh. Do not leave members staring at the pricing shell for the
    // normal card-collapse window.
    h.poster.editCard(
      claim.group_id,
      market.id,
      cardMessageId,
      fullCardText,
      keyboard,
      { urgent: true },
    );
    return { minted: true };
  }
  h.poster.post(claim.group_id, fullCardText, {
    replyToMessageId: claim.tg_message_id,
    ...(keyboard ? { keyboard } : {}),
    onSent: async (messageId) => {
      await h.deps.db.setMarketCardMessage(market.id, messageId);
    },
  });
  return { minted: true };
}

/** Post the claimer-picks-a-line options card (ambiguous / counter-offer parses). */
async function postOptions(h: HandlerCtx, claim: ClaimRow, envelope: ParseEnvelope): Promise<void> {
  const claimerUser = await h.deps.db.getUser(claim.claimer_user_id);
  const upgradeOption = envelope.options.find((option) => option.key === 'up');
  const promptKey: TemplateKey = envelope.kind === 'clarify' ? 'clarify' : 'counter_offer';
  const prompt = await h.say(promptKey, {
    question: envelope.question ?? '',
    reason: envelope.reason ?? '',
    claimer: claimerUser?.display_name ?? 'legend',
    offer: upgradeOption ? describeTerms(upgradeOption.spec) : '',
  });
  const keyboard = optionsKeyboard(
    claim.id,
    envelope.options.map(({ key, label }) => ({ key, label })),
  );
  // Single-message lifecycle: the SAME surface becomes the clarify options.
  if (editClaimSurface(h.poster, h.claimSurface, claim, prompt, keyboard)) return;
  h.poster.post(claim.group_id, prompt, {
    replyToMessageId: claim.tg_message_id,
    keyboard,
  });
}

/**
 * Route a prove outcome to its posted result. Shared by the detect path and
 * the "Run it back" retry tap. `announce` posts retry/reject feedback for
 * explicit taps and trigger words; passive detections stay silent on those.
 */
export async function routeProveOutcome(
  h: HandlerCtx,
  claim: ClaimRow,
  group: GroupRow,
  outcome: ProveOutcome,
  announce: boolean,
): Promise<void> {
  if (outcome.kind === 'retryable') {
    // Infrastructure blinked — leave a live retry button on 'nudged'.
    await h.deps.db.updateClaim(claim.id, { status: 'nudged' });
    if (announce) {
      h.poster.post(claim.group_id, await h.say('prove_retry'), {
        replyToMessageId: claim.tg_message_id,
        keyboard: retryParseKeyboard(claim.id),
      });
    }
    return;
  }
  if (outcome.kind === 'reject') {
    await h.deps.db.updateClaim(claim.id, { status: 'declined' });
    if (announce) {
      h.poster.post(claim.group_id, await h.say('reject', { message: outcome.message }), {
        replyToMessageId: claim.tg_message_id,
      });
    }
    return;
  }
  const envelope = outcome.envelope;
  await h.deps.db.updateClaim(claim.id, { parse: envelope });
  switch (envelope.kind) {
    case 'ok':
      await mintOffer(h, claim, group, envelope, 'ok');
      return;
    case 'clarify':
    case 'counter_offer':
      await postOptions(h, claim, envelope);
      return;
    case 'awaiting_confirm':
      return;
  }
}

export interface OfferArgs {
  chatId: number;
  group: GroupRow;
  text: string;
  claimer: User;
  sourceMessageId: number;
  confidence: number | null;
  /** true for @mention/"book it" triggers — posts retry/reject feedback. */
  announce: boolean;
  /** Omitted callers fail closed into owner confirmation. */
  consent?: 'explicit' | 'awaiting_confirm';
}

async function postConfirmationGate(h: HandlerCtx, claim: ClaimRow): Promise<void> {
  const claimer = await h.deps.db.getUser(claim.claimer_user_id);
  const name = claimer?.display_name ?? 'The author';
  h.poster.post(
    claim.group_id,
    `${name}, confirm this is your call. No offer goes live until you do.`,
    {
      replyToMessageId: claim.tg_message_id,
      keyboard: confirmKeyboard(claim.id),
      onSent: async (messageId) => {
        // The consent gate is the claim's canonical surface: every later
        // pre-mint state edits this message, and the market card inherits it.
        h.claimSurface?.remember(claim.id, messageId);
        await h.deps.db.setClaimSurfaceMessage(claim.id, messageId);
        const current = await h.deps.db.getClaim(claim.id);
        if (current?.status !== 'awaiting_confirm') return;
        await h.deps.db.updateClaim(claim.id, {
          parse: { raw: null, kind: 'awaiting_confirm', options: [], gateMessageId: messageId },
        });
      },
    },
  );
}

/**
 * The single-message lifecycle's first surface for explicit (/bookit,
 * @mention) claims: a short "reading the call…" shell posted the moment the
 * claim commits, so the group sees instant presence. Its id is the canonical
 * surface every later state edits (options, skeleton, offer, board). Flag off,
 * this is skipped and the skeleton card is the first message, as before.
 */
async function postReadingShell(h: HandlerCtx, claim: ClaimRow): Promise<void> {
  const claimer = await h.deps.db.getUser(claim.claimer_user_id);
  h.poster.post(
    claim.group_id,
    readingCardText({
      quotedText: claim.quoted_text,
      claimerName: claimer?.display_name ?? 'the claimer',
      isReplay: h.supervisor.replayRunId(claim.group_id) !== null,
    }),
    {
      replyToMessageId: claim.tg_message_id,
      onSent: async (messageId) => {
        h.claimSurface?.remember(claim.id, messageId);
        await h.deps.db.setClaimSurfaceMessage(claim.id, messageId);
      },
    },
  );
}

/**
 * Insert the claim and immediately parse → price → mint (or offer options).
 * Charges one LLM budget unit for the parse; when exhausted, trigger paths say
 * so and passive detections stay silent.
 */
export async function offerClaim(h: HandlerCtx, args: OfferArgs): Promise<void> {
  const consent = args.consent ?? 'awaiting_confirm';
  if (consent === 'explicit' && !h.budget.allow(args.group.id)) {
    h.deps.log.info('llm_budget_exhausted');
    if (args.announce) {
      h.poster.post(args.chatId, await h.say('budget_spent'), {
        replyToMessageId: args.sourceMessageId,
      });
    }
    return;
  }
  const claim = await h.deps.db.insertClaim({
    group_id: args.chatId,
    claimer_user_id: args.claimer.id,
    tg_message_id: args.sourceMessageId,
    quoted_text: args.text,
    status: consent === 'explicit' ? 'clarifying' : 'awaiting_confirm',
    classifier_confidence: args.confidence,
    expires_at: consent === 'explicit' ? extendedClaimExpiry(h.deps) : confirmationExpiry(h.deps),
  });
  // Every path that commits to a claim funnels through this insert (mention,
  // "book it"/bookit reply, passive detection past the classifier), so this
  // one reaction is the zero-clutter "seen it" ack — once per claim, in every
  // chattiness mode, because reactions are budget-free.
  h.poster.react(args.chatId, args.sourceMessageId, '👀');
  h.deps.log.info('offer_claim', {
    claimId: claim.id,
    confidence: args.confidence,
    consent,
  });
  if (consent !== 'explicit') {
    await postConfirmationGate(h, claim);
    return;
  }
  // Single-message lifecycle: an explicit call opens with a "reading the call…"
  // shell whose id every later state (options, skeleton, offer, board) edits.
  if (h.claimSurface !== undefined) await postReadingShell(h, claim);
  // In a replaying group, pin the parse to the replayed fixture (else ambiguous
  // team names — several active fixtures for one team — reject and go silent).
  const replayFixtureId = h.supervisor.replayFixture(args.chatId) ?? undefined;
  const replay = replayFixtureId === undefined
    ? undefined
    : replayContext(h, args.chatId, replayFixtureId);
  h.poster.chatAction(args.chatId, 'typing');
  const outcome = await proveClaim(h.deps, claim, replayFixtureId, replay);
  await routeProveOutcome(h, claim, args.group, outcome, args.announce);
}

/** Exposed for the "Run it back" retry: re-parse and re-route under the claim lock. */
export async function retryOffer(h: HandlerCtx, claim: ClaimRow, group: GroupRow): Promise<void> {
  const replayFixtureId = h.supervisor.replayFixture(group.id) ?? undefined;
  const replay = replayFixtureId === undefined
    ? undefined
    : replayContext(h, group.id, replayFixtureId);
  h.poster.chatAction(group.id, 'typing');
  const outcome = await proveClaim(h.deps, claim, replayFixtureId, replay);
  await routeProveOutcome(h, claim, group, outcome, true);
}
