import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import {
  ConfirmIntentSchema,
  CreateIntentSchema,
  GroupIntentSchema,
  intentJson,
} from './account-protocol.js';
import type { AccountApiContext } from './account-api.js';
import {
  loadBoundIntent,
  requireOpenBoundMarket,
  requireOpenCreateMarket,
} from './account-intent-guards.js';
import { sendJson } from './server-http.js';

const INTENT_TTL_MS = 10 * 60_000;

type IntentOperationInput = {
  readonly context: AccountApiContext;
  readonly intentId: string;
  readonly rawBody: unknown;
  readonly res: ServerResponse;
};

export async function handleCreateIntent(
  context: AccountApiContext,
  rawBody: unknown,
  res: ServerResponse,
): Promise<true> {
  const body = CreateIntentSchema.safeParse(rawBody);
  if (!body.success) return badRequest(res);
  if (!context.rateLimiter.allow({ operation: 'intent_write', principal: body.data.principal })) {
    return rateLimited(res);
  }
  const wager = context.deps.wager;
  if (wager === null) return wagerUnavailable(res);
  const market = await requireOpenCreateMarket(context, body.data.principal, body.data.marketId);
  if (!market.ok) return refusal(res, market);
  const expiresAt = new Date(context.deps.now() + INTENT_TTL_MS).toISOString();
  const created = await wager.account.createPendingStakeIntent({
    user_id: body.data.principal.userId,
    group_id: body.data.principal.groupId,
    market_id: market.market.id,
    side: body.data.side,
    lamports: body.data.lamports,
    intent_key_hash_hex: hashCorrelation(body.data.correlationId),
    expires_at: expiresAt,
  });
  if (!created.ok) {
    return refusal(res, {
      ok: false,
      error: created.code,
      status: created.code === 'active_intent_exists' ? 409 : 400,
    });
  }
  const intent = await wager.account.getPendingStakeIntent(body.data.principal.userId, created.intent_id);
  if (!intent.ok) {
    sendJson(res, 503, { error: 'intent_unavailable' });
    return true;
  }
  sendJson(res, 201, { intent: intentJson(intent.intent) });
  return true;
}

export async function handleReadActiveIntent(
  context: AccountApiContext,
  rawBody: unknown,
  res: ServerResponse,
): Promise<true> {
  const body = GroupIntentSchema.safeParse(rawBody);
  if (!body.success) return badRequest(res);
  if (!context.rateLimiter.allow({ operation: 'intent_read', principal: body.data.principal })) {
    return rateLimited(res);
  }
  const wager = context.deps.wager;
  if (wager === null) return wagerUnavailable(res);
  const result = await wager.account.resolveActiveStakeIntent(body.data.principal.userId);
  if (!result.ok || result.intent.group_id !== body.data.principal.groupId) {
    sendJson(res, 200, { activeIntent: null });
    return true;
  }
  if (Date.parse(result.intent.expires_at) <= context.deps.now()) {
    sendJson(res, 200, { activeIntent: null });
    return true;
  }
  sendJson(res, 200, { activeIntent: intentJson(result.intent) });
  return true;
}

export async function handleCancelIntent(input: IntentOperationInput): Promise<true> {
  const { context, intentId, rawBody, res } = input;
  const body = GroupIntentSchema.safeParse(rawBody);
  if (!body.success) return badRequest(res);
  if (!context.rateLimiter.allow({ operation: 'intent_write', principal: body.data.principal })) {
    return rateLimited(res);
  }
  const bound = await loadBoundIntent(context, body.data.principal, intentId);
  if (!bound.ok) return refusal(res, bound);
  const wager = context.deps.wager;
  if (wager === null) return wagerUnavailable(res);
  const cancelled = await wager.account.cancelStakeIntent(body.data.principal.userId, bound.intent.id);
  if (!cancelled.ok) return refusal(res, { ok: false, error: cancelled.code, status: 409 });
  sendJson(res, 200, { intent: { intentId: bound.intent.id, state: 'cancelled' } });
  return true;
}

export async function handleFundingObserved(input: IntentOperationInput): Promise<true> {
  const { context, intentId, rawBody, res } = input;
  const body = GroupIntentSchema.safeParse(rawBody);
  if (!body.success) return badRequest(res);
  if (!context.rateLimiter.allow({ operation: 'intent_write', principal: body.data.principal })) {
    return rateLimited(res);
  }
  const bound = await loadBoundIntent(context, body.data.principal, intentId);
  if (!bound.ok) return refusal(res, bound);
  const market = await requireOpenBoundMarket(context, bound.intent);
  if (!market.ok) return refusal(res, market);
  const wager = context.deps.wager;
  if (wager === null) return wagerUnavailable(res);
  const funded = await wager.account.markStakeIntentFunded(body.data.principal.userId, bound.intent.id);
  if (!funded.ok) return refusal(res, { ok: false, error: funded.code, status: 409 });
  sendJson(res, 200, { intent: { ...intentJson(bound.intent), state: 'ready' } });
  return true;
}

export async function handleConfirmIntent(input: IntentOperationInput): Promise<true> {
  const { context, intentId, rawBody, res } = input;
  const body = ConfirmIntentSchema.safeParse(rawBody);
  if (!body.success) return badRequest(res);
  if (!context.rateLimiter.allow({ operation: 'intent_write', principal: body.data.principal })) {
    return rateLimited(res);
  }
  if (body.data.finalConfirmation !== true) {
    sendJson(res, 409, { error: 'final_confirmation_required' });
    return true;
  }
  const bound = await loadBoundIntent(context, body.data.principal, intentId);
  if (!bound.ok) return refusal(res, bound);
  const market = await requireOpenBoundMarket(context, bound.intent);
  if (!market.ok) return refusal(res, market);
  if (bound.intent.state !== 'ready') {
    sendJson(res, 409, { error: 'intent_not_ready' });
    return true;
  }
  const wager = context.deps.wager;
  if (wager === null) return wagerUnavailable(res);
  const consumed = await wager.account.consumeReadyStakeIntent(body.data.principal.userId, bound.intent.id);
  if (!consumed.ok) return refusal(res, { ok: false, error: consumed.code, status: 409 });
  sendJson(res, 200, { intent: intentJson(consumed.intent) });
  return true;
}

function hashCorrelation(correlationId: string): string {
  return createHash('sha256').update(`stake-intent:${correlationId}`).digest('hex');
}

function badRequest(res: ServerResponse): true {
  sendJson(res, 400, { error: 'bad_request' });
  return true;
}

function rateLimited(res: ServerResponse): true {
  sendJson(res, 429, { error: 'rate_limited' });
  return true;
}

function wagerUnavailable(res: ServerResponse): true {
  sendJson(res, 503, { error: 'wager_unavailable' });
  return true;
}

function refusal(
  res: ServerResponse,
  result: { readonly ok: false; readonly error: string; readonly status: number },
): true {
  sendJson(res, result.status, { error: result.error });
  return true;
}
