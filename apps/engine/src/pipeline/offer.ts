/**
 * Detect → offer → mint, collapsed. Callie is a broker: the moment a claim is
 * detected (or triggered) she parses it, prices it, and — if it compiles
 * cleanly — mints the SOL market and posts ONE offer card with Back / Against
 * buttons. Ambiguous claims get an options card (claimer picks, then it mints);
 * infrastructure blips leave a "Run it back" retry. No prove → confirm gate.
 *
 * The mint price LOCKS the FOR↔AGAINST settlement ratio (wager/pot.ts), so the
 * one-market-per-claim guard must stay inside the caller's claim lock (there is
 * no unique index on markets.claim_id).
 */

import type { User } from 'grammy/types';
import { TUNABLES } from '@calledit/market-engine';
import type { ClaimRow, Deps, GroupRow } from '../ports.js';
import type { HandlerCtx } from '../bot/context.js';
import { describeTerms } from '../bot/cards.js';
import { offerKeyboard, optionsKeyboard, retryParseKeyboard, retryQuoteKeyboard } from '../bot/keyboards.js';
import type { TemplateKey } from '../bot/copy.js';
import { composeClaimCard } from './render.js';
import {
  checkMintWindow,
  createMarketFromClaim,
  isDegenerateQuote,
  proveClaim,
  quoteSpec,
  type ParseEnvelope,
  type ProveOutcome,
} from './claims.js';

/** The claim TTL is an inactivity deadline; every meaningful step pushes it out. */
function extendedClaimExpiry(deps: Deps): string {
  return new Date(deps.now() + TUNABLES.UNCONFIRMED_CLAIM_TTL_MS).toISOString();
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

  // This quote LOCKS the settlement ratio — never mint on a failed/degenerate price.
  const outcome = await quoteSpec(h.deps, spec, replayAsOfMs(h, claim.group_id, spec.fixtureId));
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

  const fixture = await h.deps.db.getFixture(spec.fixtureId);
  if (!fixture) {
    // A fixture-lookup miss is transient (cache mid-sync) — offer a retry.
    await h.deps.db.updateClaim(claim.id, { expires_at: extendedClaimExpiry(h.deps) });
    h.poster.post(claim.group_id, await h.say('hiccup'), {
      replyToMessageId: claim.tg_message_id,
      keyboard: retryQuoteKeyboard(claim.id, optionKey),
    });
    return { minted: false };
  }
  const window = checkMintWindow(spec, fixture, h.deps.now());
  if (!window.open) {
    await h.deps.db.updateClaim(claim.id, { status: 'expired' });
    h.poster.post(claim.group_id, await h.say('window_closed'), {
      replyToMessageId: claim.tg_message_id,
    });
    return { minted: false };
  }

  // One market per claim — belt-and-braces against a double mint (crash between
  // the market insert and the status flip). Runs inside the caller's claim lock.
  const openMarkets = await h.deps.db.openMarketsForGroup(group.id);
  if (openMarkets.some((market) => market.claim_id === claim.id)) {
    await h.deps.db.updateClaim(claim.id, { status: 'confirmed' });
    return { minted: false };
  }

  const isReplay = h.supervisor.replayFixture(group.id) === spec.fixtureId;
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
    isReplay,
    fixture,
  });

  const card = await composeClaimCard(h.deps, market);
  if (!card) return { minted: true };
  const claimer = await h.deps.db.getUser(claim.claimer_user_id);
  const garnish = await h.say('offer_live', { claimer: claimer?.display_name ?? 'legend' });
  const pendingNote =
    market.status === 'pending_lineup' ? `\n${await h.say('pending_lineup_note')}` : '';
  h.poster.post(claim.group_id, `${garnish}${pendingNote}\n\n${card.text}`, {
    replyToMessageId: claim.tg_message_id,
    keyboard: offerKeyboard(h.deps, market, claim.id),
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
  h.poster.post(claim.group_id, prompt, {
    replyToMessageId: claim.tg_message_id,
    keyboard: optionsKeyboard(
      claim.id,
      envelope.options.map(({ key, label }) => ({ key, label })),
    ),
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
  if (envelope.kind === 'ok') {
    await mintOffer(h, claim, group, envelope, 'ok');
    return;
  }
  await postOptions(h, claim, envelope);
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
}

/**
 * Insert the claim and immediately parse → price → mint (or offer options).
 * Charges one LLM budget unit for the parse; when exhausted, trigger paths say
 * so and passive detections stay silent.
 */
export async function offerClaim(h: HandlerCtx, args: OfferArgs): Promise<void> {
  if (!h.budget.allow(args.group.id)) {
    h.deps.log.info('llm_budget_exhausted', { groupId: args.group.id });
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
    status: 'clarifying',
    classifier_confidence: args.confidence,
    expires_at: extendedClaimExpiry(h.deps),
  });
  h.deps.log.info('offer_claim', {
    claimId: claim.id,
    groupId: args.chatId,
    confidence: args.confidence,
    trigger: args.announce,
  });
  const outcome = await proveClaim(h.deps, claim);
  await routeProveOutcome(h, claim, args.group, outcome, args.announce);
}

/** Exposed for the "Run it back" retry: re-parse and re-route under the claim lock. */
export async function retryOffer(h: HandlerCtx, claim: ClaimRow, group: GroupRow): Promise<void> {
  const outcome = await proveClaim(h.deps, claim);
  await routeProveOutcome(h, claim, group, outcome, true);
}
