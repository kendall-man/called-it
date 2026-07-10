import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import { ensureMemberSeen } from '../pipeline/stake.js';
import { buildCompileContext } from '../pipeline/context.js';
import { quoteSpec, type QuoteOutcome } from '../pipeline/claims.js';
import { composeClaimCard } from '../pipeline/render.js';
import { marketStakeKeyboard } from '../bot/keyboards.js';
import { describeTerms } from '../bot/cards.js';
import { LlmBudget } from '../bot/budget.js';
import { LAMPORTS_PER_SOL } from '../wager/format.js';
import type { EngineApiOptions } from './server.js';
import { sendJson } from './server-http.js';

const MAX_STAKE_SOL = 0.1;
const StakeBody = z.object({
  chatId: z.number().int(),
  marketId: z.string().min(1),
  userId: z.number().int(),
  displayName: z.string().min(1).max(80),
  username: z.string().max(64).nullable().default(null),
  side: z.enum(['back', 'doubt']),
  amount: z.number().positive().max(MAX_STAKE_SOL),
  idempotencyKey: z.string().min(8).max(128),
});
const QuoteBody = z.object({
  chatId: z.number().int(),
  text: z.string().min(3).max(400),
});

type QuoteJson =
  | { readonly kind: 'transient' | 'no_odds' | 'unpriceable' }
  | {
      readonly kind: 'ok';
      readonly probability: number;
      readonly backMultiplier: number;
      readonly provenance: 'market' | 'modelled';
    };

function toQuoteJson(outcome: QuoteOutcome): QuoteJson {
  if (outcome.kind !== 'ok') return { kind: outcome.kind };
  return {
    kind: 'ok',
    probability: outcome.quote.probability,
    backMultiplier: outcome.quote.multiplier,
    provenance: outcome.quote.provenance,
  };
}

export async function handleQuoteRequest(
  options: EngineApiOptions,
  quoteBudget: LlmBudget,
  rawBody: unknown,
  res: ServerResponse,
): Promise<void> {
  const body = QuoteBody.safeParse(rawBody);
  if (!body.success) {
    sendJson(res, 400, { error: 'bad_request', detail: body.error.issues[0]?.message });
    return;
  }
  const { deps, log } = options;
  if (!quoteBudget.allow(body.data.chatId)) {
    sendJson(res, 429, { error: 'llm_budget_exhausted' });
    return;
  }
  let raw;
  try {
    const seedCtx = await buildCompileContext(deps, null);
    raw = await deps.agent.parse(body.data.text, seedCtx);
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    const message = err.toString();
    log.warn('api_quote_parse_failed', { error: message });
    sendJson(res, 502, { error: 'parse_unavailable' });
    return;
  }
  const compileCtx = await buildCompileContext(deps, raw.fixtureId);
  const result = deps.engine.compileClaim(raw, compileCtx);
  if (result.kind === 'reject') {
    sendJson(res, 200, { kind: 'reject', message: result.message });
    return;
  }
  const quoteOptions =
    result.kind === 'ok'
      ? [{ key: 'ok', label: 'As stated', spec: result.spec }]
      : result.kind === 'clarify'
        ? result.options.map((option, index) => ({
            key: String(index),
            label: option.label,
            spec: option.spec,
          }))
        : [
            ...(result.asStated
              ? [{ key: 'as', label: 'As stated · Oracle-resolved', spec: result.asStated }]
              : []),
            { key: 'up', label: 'The upgrade · Chain-proven', spec: result.upgrade },
          ];
  const quoted = await Promise.all(
    quoteOptions.map(async (option) => ({
      key: option.key,
      label: option.label,
      terms: describeTerms(option.spec),
      trustTier: option.spec.trustTier,
      fixtureId: option.spec.fixtureId,
      quote: toQuoteJson(await quoteSpec(deps, option.spec)),
    })),
  );
  sendJson(res, 200, {
    kind: result.kind,
    question: result.kind === 'clarify' ? result.question : undefined,
    reason: result.kind === 'counter_offer' ? result.reason : undefined,
    options: quoted,
  });
}

export async function handleStakeRequest(
  options: EngineApiOptions,
  rawBody: unknown,
  res: ServerResponse,
): Promise<void> {
  const parsed = StakeBody.safeParse(rawBody);
  if (!parsed.success) {
    sendJson(res, 400, { error: 'bad_request', detail: parsed.error.issues[0]?.message });
    return;
  }
  const body = parsed.data;
  const { deps, poster } = options;
  const wager = deps.wager;
  if (!wager) {
    sendJson(res, 503, { error: 'wager_unavailable' });
    return;
  }
  const market = await deps.db.getMarket(body.marketId);
  if (!market || market.group_id !== body.chatId || market.currency !== 'sol') {
    sendJson(res, 404, { error: 'unknown_market' });
    return;
  }
  if (market.status !== 'open' && market.status !== 'pending_lineup') {
    sendJson(res, 409, { error: 'closed', status: market.status });
    return;
  }
  const lamports = BigInt(Math.round(body.amount * Number(LAMPORTS_PER_SOL)));
  const known = await deps.db.getUser(body.userId);
  const userName = known?.display_name ?? body.displayName;
  await ensureMemberSeen(deps, body.chatId, {
    id: body.userId,
    displayName: userName,
    username: body.username ?? known?.username ?? null,
  });
  const fixture = await deps.db.getFixture(market.fixture_id);
  const result = await wager.handleStakeTap({
    market,
    userId: body.userId,
    userName,
    side: body.side,
    lamports,
    inPlay: fixture !== null && fixture.phase !== 'NS',
    nowMs: deps.now(),
    idempotencyKey: body.idempotencyKey,
  });
  if (result.placed) {
    const fresh = await deps.db.getMarket(body.marketId);
    if (fresh && fresh.card_tg_message_id !== null) {
      const card = await composeClaimCard(deps, fresh);
      if (card && card.messageId !== null) {
        poster.editCard(
          body.chatId,
          fresh.id,
          card.messageId,
          card.text,
          marketStakeKeyboard(deps, fresh),
        );
      }
    }
  }
  sendJson(res, 200, { placed: result.placed, reply: result.reply });
}
