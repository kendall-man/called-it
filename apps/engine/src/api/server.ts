/**
 * Engine HTTP API — the integration surface for the eve concierge agent
 * ("LLM proposes, code disposes" across process boundaries). Read routes
 * mirror what the group already sees; the one mutating route (stake) routes
 * through the wager module, exactly like a Back/Against button.
 *
 * Deliberately node:http with zero new dependencies: seven routes do not
 * justify a framework, and the engine stays the single DB writer.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Deps, MarketRow } from '../ports.js';
import type { Env } from '../env.js';
import type { Logger } from '../log.js';
import type { Poster } from '../bot/poster.js';
import { LlmBudget } from '../bot/budget.js';
import { ensureMemberSeen } from '../pipeline/stake.js';
import { buildCompileContext } from '../pipeline/context.js';
import { quoteSpec, type QuoteOutcome } from '../pipeline/claims.js';
import { composeClaimCard } from '../pipeline/render.js';
import { marketStakeKeyboard } from '../bot/keyboards.js';
import { describeTerms } from '../bot/cards.js';
import { computePots } from '../wager/pot.js';
import { formatSol, LAMPORTS_PER_SOL } from '../wager/format.js';

const JSON_BODY_LIMIT_BYTES = 64 * 1024;
const FIXTURES_WINDOW_HOURS_DEFAULT = 48;
const FIXTURES_WINDOW_HOURS_MAX = 24 * 7;
/** Per-market stake ceiling in SOL — mirrors the wager module's lamport cap. */
const MAX_STAKE_SOL = 0.1;

const StakeBody = z.object({
  chatId: z.number().int(),
  marketId: z.string().min(1),
  userId: z.number().int(),
  displayName: z.string().min(1).max(80),
  username: z.string().max(64).nullable().default(null),
  side: z.enum(['back', 'doubt']),
  /** Devnet SOL, e.g. 0.05. Converted to lamports at the boundary. */
  amount: z.number().positive().max(MAX_STAKE_SOL),
  /** Required: the concierge's tool steps re-run on interruption. */
  idempotencyKey: z.string().min(8).max(128),
});

const QuoteBody = z.object({
  chatId: z.number().int(),
  text: z.string().min(3).max(400),
});

export interface EngineApiOptions {
  deps: Deps;
  poster: Poster;
  env: Env;
  log: Logger;
  /**
   * Webhook-ingress mode: the concierge owns the Telegram webhook and
   * forwards every update the agent doesn't handle (plain group chatter,
   * commands, card-button callback queries) here; this feeds them into the
   * existing grammY handlers via bot.handleUpdate.
   */
  handleTelegramUpdate?: (update: Record<string, unknown>) => Promise<void>;
}

/** Starts the API when ENGINE_API_TOKEN is configured; otherwise a no-op. */
export function startEngineApi(options: EngineApiOptions): Server | null {
  const { deps, env, log } = options;
  const token = env.ENGINE_API_TOKEN;
  if (!token) {
    log.info('engine_api_disabled', { reason: 'ENGINE_API_TOKEN not set' });
    return null;
  }
  const quoteBudget = new LlmBudget(undefined, deps.now);
  const server = createServer((req, res) => {
    const requestId = randomUUID();
    res.setHeader('x-request-id', requestId);
    void route(options, quoteBudget, token, req, res).catch((err) => {
      if (err instanceof PayloadTooLargeError) {
        sendJson(res, 413, { error: 'payload_too_large' });
        return;
      }
      log.error('engine_api_unhandled', { error: String(err), requestId });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
    });
  });
  server.listen(env.PORT, () => {
    log.info('engine_api_up', { port: env.PORT });
  });
  return server;
}

async function route(
  options: EngineApiOptions,
  quoteBudget: LlmBudget,
  token: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://engine.local');
  const path = url.pathname;
  if (path === '/api/health') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (path === '/api/ready') {
    try {
      const now = options.deps.now();
      await options.deps.db.fixturesBetween(now, now);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      options.log.warn('engine_api_not_ready', { error: String(err) });
      sendJson(res, 503, { error: 'not_ready' });
    }
    return;
  }
  if (!authorized(req, token)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }
  const { deps } = options;

  const snapshotMatch = path.match(/^\/api\/groups\/(-?\d+)\/snapshot$/);
  if (req.method === 'GET' && snapshotMatch) {
    await handleSnapshot(options, Number(snapshotMatch[1]), res);
    return;
  }
  const walletMatch = path.match(/^\/api\/groups\/(-?\d+)\/users\/(\d+)\/wallet$/);
  if (req.method === 'GET' && walletMatch) {
    await handleWallet(options, Number(walletMatch[1]), Number(walletMatch[2]), res);
    return;
  }
  const marketMatch = path.match(/^\/api\/markets\/([0-9a-f-]{36})$/);
  if (req.method === 'GET' && marketMatch) {
    await handleMarket(options, marketMatch[1]!, res);
    return;
  }
  if (req.method === 'GET' && path === '/api/fixtures') {
    const hours = clampHours(url.searchParams.get('hours'));
    const from = deps.now();
    const fixtures = await deps.db.fixturesBetween(from - 3 * 3600_000, from + hours * 3600_000);
    sendJson(res, 200, {
      fixtures: fixtures.map((f) => ({
        fixtureId: f.fixture_id,
        home: f.p1_name,
        away: f.p2_name,
        kickoffAt: f.kickoff_at,
        phase: f.phase,
        minute: f.minute,
      })),
    });
    return;
  }
  if (req.method === 'POST' && path === '/api/quote') {
    const body = QuoteBody.safeParse(await readJson(req));
    if (!body.success) {
      sendJson(res, 400, { error: 'bad_request', detail: body.error.issues[0]?.message });
      return;
    }
    await handleQuote(options, quoteBudget, body.data, res);
    return;
  }
  if (req.method === 'POST' && path === '/api/stake') {
    const body = StakeBody.safeParse(await readJson(req));
    if (!body.success) {
      sendJson(res, 400, { error: 'bad_request', detail: body.error.issues[0]?.message });
      return;
    }
    await handleApiStake(options, body.data, res);
    return;
  }
  if (req.method === 'POST' && path === '/api/telegram-update') {
    if (!options.handleTelegramUpdate) {
      sendJson(res, 409, { error: 'not_webhook_ingress' });
      return;
    }
    const update = await readJson(req);
    if (!update || typeof update !== 'object') {
      sendJson(res, 400, { error: 'bad_request' });
      return;
    }
    // Ack immediately; processing is fire-and-forget like a polled update.
    sendJson(res, 200, { ok: true });
    void options.handleTelegramUpdate(update as Record<string, unknown>).catch((err) => {
      options.log.error('forwarded_update_failed', { error: String(err) });
    });
    return;
  }
  sendJson(res, 404, { error: 'not_found' });
}

// ── handlers ─────────────────────────────────────────────────────────────────

async function handleSnapshot(options: EngineApiOptions, chatId: number, res: ServerResponse) {
  const { deps } = options;
  const group = await deps.db.getGroup(chatId);
  if (!group) {
    sendJson(res, 404, { error: 'unknown_group' });
    return;
  }
  const markets = await deps.db.openMarketsForGroup(chatId);
  sendJson(res, 200, {
    group: { id: group.id, title: group.title },
    markets: await Promise.all(markets.map((m) => marketSummary(deps, m))),
  });
}

async function handleWallet(
  options: EngineApiOptions,
  chatId: number,
  userId: number,
  res: ServerResponse,
) {
  const { deps } = options;
  const wager = deps.wager;
  if (!wager) {
    sendJson(res, 503, { error: 'wager_unavailable' });
    return;
  }
  const { balanceLamports, pubkey } = await wager.walletSummary(userId);
  const open = await deps.db.openMarketsForGroup(chatId);
  const positions: Array<Record<string, unknown>> = [];
  for (const market of open) {
    const mine = (await deps.db.positionsForMarket(market.id)).filter(
      (p) => p.user_id === userId && p.state !== 'void',
    );
    for (const p of mine) {
      const stakeLamports = BigInt(p.stake);
      positions.push({
        marketId: market.id,
        terms: describeTerms(market.spec),
        side: p.side,
        stakeLamports: stakeLamports.toString(),
        stakeSol: formatSol(stakeLamports),
        state: p.state,
      });
    }
  }
  sendJson(res, 200, {
    linkedWallet: pubkey,
    balanceLamports: balanceLamports.toString(),
    balanceSol: formatSol(balanceLamports),
    positions,
  });
}

async function handleMarket(options: EngineApiOptions, marketId: string, res: ServerResponse) {
  const { deps, env } = options;
  const market = await deps.db.getMarket(marketId);
  if (!market) {
    sendJson(res, 404, { error: 'unknown_market' });
    return;
  }
  sendJson(res, 200, await marketSummary(deps, market, env.WEB_BASE_URL));
}

async function handleQuote(
  options: EngineApiOptions,
  quoteBudget: LlmBudget,
  body: z.infer<typeof QuoteBody>,
  res: ServerResponse,
) {
  const { deps, log } = options;
  if (!quoteBudget.allow(body.chatId)) {
    sendJson(res, 429, { error: 'llm_budget_exhausted' });
    return;
  }
  let raw;
  try {
    const seedCtx = await buildCompileContext(deps, null);
    raw = await deps.agent.parse(body.text, seedCtx);
  } catch (err) {
    log.warn('api_quote_parse_failed', { error: String(err) });
    sendJson(res, 502, { error: 'parse_unavailable' });
    return;
  }
  const compileCtx = await buildCompileContext(deps, raw.fixtureId);
  const result = deps.engine.compileClaim(raw, compileCtx);
  if (result.kind === 'reject') {
    sendJson(res, 200, { kind: 'reject', message: result.message });
    return;
  }
  const options_ =
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
    options_.map(async (option) => ({
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

async function handleApiStake(
  options: EngineApiOptions,
  body: z.infer<typeof StakeBody>,
  res: ServerResponse,
) {
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

  // The concierge only knows the Telegram username; keep any stored real name
  // (button taps carry it) so the API's upsert can't degrade it.
  const known = await deps.db.getUser(body.userId);
  const userName = known?.display_name ?? body.displayName;
  await ensureMemberSeen(deps, body.chatId, {
    id: body.userId,
    displayName: userName,
    username: body.username ?? known?.username ?? null,
  });

  const fixture = await deps.db.getFixture(market.fixture_id);
  const inPlay = fixture !== null && fixture.phase !== 'NS';
  const result = await wager.handleStakeTap({
    market,
    userId: body.userId,
    userName,
    side: body.side,
    lamports,
    inPlay,
    nowMs: deps.now(),
    idempotencyKey: body.idempotencyKey,
  });

  if (result.placed) {
    // Same group-visible side effect as a button tap: refresh the card tally.
    const fresh = await deps.db.getMarket(body.marketId);
    if (fresh && fresh.card_tg_message_id !== null) {
      const card = await composeClaimCard(deps, fresh);
      if (card && card.messageId !== null) {
        poster.editCard(body.chatId, fresh.id, card.messageId, card.text, marketStakeKeyboard(deps, fresh));
      }
    }
  }
  // Every outcome that reached the wager module is a 200 — `reply` explains it
  // (placed, idempotent replay, insufficient balance, paused, …).
  sendJson(res, 200, { placed: result.placed, reply: result.reply });
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function marketSummary(deps: Deps, market: MarketRow, webBaseUrl?: string) {
  const positions = await deps.db.positionsForMarket(market.id);
  const live = positions.filter((p) => p.state !== 'void');
  // Card-consistent pots: non-void positions at the market's locked probability.
  const pots = computePots(live, market.quote_probability);
  return {
    marketId: market.id,
    terms: describeTerms(market.spec),
    currency: 'sol',
    status: market.status,
    fixtureId: market.fixture_id,
    isReplay: market.is_replay,
    trustTier: market.spec.trustTier,
    probability: market.quote_probability,
    backers: live.filter((p) => p.side === 'back').length,
    doubters: live.filter((p) => p.side === 'doubt').length,
    forLamports: pots.forLamports.toString(),
    againstLamports: pots.againstLamports.toString(),
    forSol: formatSol(pots.forLamports),
    againstSol: formatSol(pots.againstLamports),
    matchedPct: pots.matchedPct,
    ...(webBaseUrl ? { receiptUrl: `${webBaseUrl}/r/${market.id}` } : {}),
  };
}

function toQuoteJson(outcome: QuoteOutcome) {
  if (outcome.kind !== 'ok') return { kind: outcome.kind };
  return {
    kind: 'ok' as const,
    probability: outcome.quote.probability,
    backMultiplier: outcome.quote.multiplier,
    provenance: outcome.quote.provenance,
  };
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;
  // Hash both sides so timingSafeEqual gets equal-length buffers.
  const presented = createHash('sha256').update(header.slice('Bearer '.length)).digest();
  const expected = createHash('sha256').update(token).digest();
  return timingSafeEqual(presented, expected);
}

class PayloadTooLargeError extends Error {
  constructor() {
    super('request body exceeds the JSON limit');
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > JSON_BODY_LIMIT_BYTES) throw new PayloadTooLargeError();
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

function clampHours(value: string | null): number {
  const parsed = Number(value ?? FIXTURES_WINDOW_HOURS_DEFAULT);
  if (!Number.isFinite(parsed) || parsed <= 0) return FIXTURES_WINDOW_HOURS_DEFAULT;
  return Math.min(parsed, FIXTURES_WINDOW_HOURS_MAX);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}
