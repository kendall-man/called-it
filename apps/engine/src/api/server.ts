import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Deps } from '../ports.js';
import type { Env } from '../env.js';
import type { Logger } from '../log.js';
import type { Poster } from '../bot/poster.js';
import { LlmBudget } from '../bot/budget.js';
import type { DrainState, ReadinessEvaluator } from './readiness.js';
import {
  authorized,
  clampHours,
  isRecord,
  readJson,
  sendJson,
} from './server-http.js';
import {
  handleFixtures,
  handleMarket,
  handleSnapshot,
  handleWallet,
} from './server-read.js';
import { handleQuoteRequest, handleStakeRequest } from './server-write.js';

export interface EngineApiOptions {
  deps: Deps;
  poster: Poster;
  env: Env;
  log: Logger;
  readiness: ReadinessEvaluator;
  drainState: DrainState;
  handleTelegramUpdate?: (update: Record<string, unknown>) => Promise<void>;
}

export function startEngineApi(options: EngineApiOptions): Server {
  const token = options.env.ENGINE_API_TOKEN;
  const quoteBudget = new LlmBudget(undefined, options.deps.now);
  const server = createServer((req, res) => {
    void route(options, quoteBudget, token, req, res).catch((err) => {
      options.log.error('engine_api_unhandled', { error: String(err) });
      sendJson(res, 500, { error: 'internal' });
    });
  });
  server.listen(options.env.PORT, () => {
    options.log.info('engine_api_up', { port: options.env.PORT });
  });
  return server;
}

async function route(
  options: EngineApiOptions,
  quoteBudget: LlmBudget,
  token: string | undefined,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://engine.local');
  const path = url.pathname;
  if (path === '/api/health') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (path === '/api/live') {
    sendJson(res, 200, { status: 'live' });
    return;
  }
  if (path === '/api/ready') {
    const report = await options.readiness.evaluate();
    sendJson(res, report.status === 'ready' ? 200 : 503, report);
    return;
  }
  if (options.drainState.isDraining()) {
    sendJson(res, 503, { error: 'draining' });
    return;
  }
  if (!authorized(req, token)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  const snapshotChatId = path.match(/^\/api\/groups\/(-?\d+)\/snapshot$/)?.[1];
  if (req.method === 'GET' && snapshotChatId !== undefined) {
    await handleSnapshot(options, Number(snapshotChatId), res);
    return;
  }
  const walletMatch = path.match(/^\/api\/groups\/(-?\d+)\/users\/(\d+)\/wallet$/);
  const walletChatId = walletMatch?.[1];
  const walletUserId = walletMatch?.[2];
  if (req.method === 'GET' && walletChatId !== undefined && walletUserId !== undefined) {
    await handleWallet(options, Number(walletChatId), Number(walletUserId), res);
    return;
  }
  const marketId = path.match(/^\/api\/markets\/([0-9a-f-]{36})$/)?.[1];
  if (req.method === 'GET' && marketId !== undefined) {
    await handleMarket(options, marketId, res);
    return;
  }
  if (req.method === 'GET' && path === '/api/fixtures') {
    await handleFixtures(options, clampHours(url.searchParams.get('hours')), res);
    return;
  }
  if (req.method === 'POST' && path === '/api/quote') {
    await handleQuoteRequest(options, quoteBudget, await readJson(req), res);
    return;
  }
  if (req.method === 'POST' && path === '/api/stake') {
    await handleStakeRequest(options, await readJson(req), res);
    return;
  }
  if (req.method === 'POST' && path === '/api/telegram-update') {
    if (!options.handleTelegramUpdate) {
      sendJson(res, 409, { error: 'not_webhook_ingress' });
      return;
    }
    const update = await readJson(req);
    if (!isRecord(update)) {
      sendJson(res, 400, { error: 'bad_request' });
      return;
    }
    sendJson(res, 200, { ok: true });
    void options.handleTelegramUpdate(update).catch((err) => {
      options.log.error('forwarded_update_failed', { error: String(err) });
    });
    return;
  }
  sendJson(res, 404, { error: 'not_found' });
}
