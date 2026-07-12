import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Deps } from '../ports.js';
import type { Env } from '../env.js';
import type { Logger } from '../log.js';
import type { Poster } from '../bot/poster.js';
import { LlmBudget } from '../bot/budget.js';
import type { DrainState, ReadinessEvaluator } from './readiness.js';
import {
  clampHours,
  createRouteCredentialBoundary,
  isRecord,
  readJson,
  redactedFailureReason,
  type RouteCredentialBoundary,
  type RouteCredentials,
  type RouteScope,
  sendJson,
} from './server-http.js';
import {
  handleFixtures,
  handleMarket,
  handleSnapshot,
  handleWallet,
} from './server-read.js';
import { handleQuoteRequest } from './server-write.js';

export interface TelegramIngressPort {
  accept(update: Record<string, unknown>): Promise<void>;
}

export interface EngineApiOptions {
  deps: Deps;
  poster: Poster;
  env: Env;
  log: Logger;
  readiness: ReadinessEvaluator;
  drainState: DrainState;
  telegramIngress?: TelegramIngressPort;
}

export function startEngineApi(options: EngineApiOptions): Server {
  const credentials = createRouteCredentialBoundary(routeCredentials(options.env));
  const quoteBudget = new LlmBudget(undefined, options.deps.now);
  const server = createServer((req, res) => {
    const requestId = randomUUID();
    void route(options, quoteBudget, credentials, req, res).catch((err) => {
      options.log.error('engine_api_unhandled', {
        requestId,
        reason: redactedFailureReason(err),
      });
      sendJson(res, 500, { error: 'internal', requestId });
    });
  });
  server.listen(options.env.PORT, () => {
    options.log.info('engine_api_up');
  });
  return server;
}

async function route(
  options: EngineApiOptions,
  quoteBudget: LlmBudget,
  credentials: RouteCredentialBoundary,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://engine.local');
  const path = url.pathname;
  if (credentials.hasCredentialSearchParam(url)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }
  const body = await readBodyWithoutCredentials(req, res, credentials);
  if (body.kind === 'rejected') return;
  if (path === '/api/live') {
    sendJson(res, 200, { status: 'live' });
    return;
  }
  if (path === '/api/ready') {
    const report = await options.readiness.evaluate();
    sendJson(res, report.status === 'ready' ? 200 : 503, report);
    return;
  }
  const routeScope = allowedScopes(req.method ?? 'GET', path);
  if (routeScope === null) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }
  const authorization = credentials.authorize(req, routeScope);
  if (authorization.kind === 'unauthorized') {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }
  if (authorization.kind === 'wrong_scope') {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  if (req.method === 'GET' && path === '/api/ops/status') {
    const report = await options.readiness.evaluate();
    sendJson(res, 200, {
      status: report.status,
      reasons: report.reasons,
      draining: options.drainState.isDraining(),
    });
    return;
  }
  if (options.drainState.isDraining()) {
    sendJson(res, 503, { error: 'draining' });
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
    await handleQuoteRequest(options, quoteBudget, body.value, res);
    return;
  }
  if (req.method === 'POST' && path === '/api/telegram-ingress') {
    if (!options.telegramIngress) {
      sendJson(res, 409, { error: 'not_webhook_ingress' });
      return;
    }
    const update = body.value;
    if (!isRecord(update)) {
      sendJson(res, 400, { error: 'bad_request' });
      return;
    }
    await options.telegramIngress.accept(update);
    sendJson(res, 200, { ok: true });
    return;
  }
  sendJson(res, 404, { error: 'not_found' });
}

function routeCredentials(env: Env): RouteCredentials {
  return {
    concierge: env.ENGINE_CONCIERGE_TOKEN,
    telegram: env.ENGINE_TELEGRAM_TOKEN,
    ops: env.ENGINE_OPS_TOKEN,
  };
}

function allowedScopes(method: string, path: string): ReadonlySet<RouteScope> | null {
  if (method === 'GET' && /^\/api\/groups\/-?\d+\/snapshot$/.test(path)) return concierge();
  if (method === 'GET' && /^\/api\/groups\/-?\d+\/users\/\d+\/wallet$/.test(path)) return concierge();
  if (method === 'GET' && /^\/api\/markets\/[0-9a-f-]{36}$/.test(path)) return concierge();
  if (method === 'GET' && path === '/api/fixtures') return concierge();
  if (method === 'POST' && path === '/api/quote') return concierge();
  if (method === 'POST' && path === '/api/telegram-ingress') return telegram();
  if (method === 'GET' && path === '/api/ops/status') return ops();
  return null;
}

async function readBodyWithoutCredentials(
  req: IncomingMessage,
  res: ServerResponse,
  credentials: RouteCredentialBoundary,
): Promise<
  | { readonly kind: 'rejected'; readonly value: undefined }
  | { readonly kind: 'ok'; readonly value: unknown }
> {
  if (!requestHasBody(req)) {
    return { kind: 'ok', value: undefined };
  }
  const body = await readJson(req);
  if (credentials.hasCredentialField(body)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return { kind: 'rejected', value: undefined };
  }
  return { kind: 'ok', value: body };
}

function requestHasBody(req: IncomingMessage): boolean {
  const contentLengthHeader = req.headers['content-length'];
  const contentLength = Array.isArray(contentLengthHeader)
    ? contentLengthHeader[0]
    : contentLengthHeader;
  if (contentLength !== undefined) return contentLength !== '0';
  return req.headers['transfer-encoding'] !== undefined;
}

function concierge(): ReadonlySet<RouteScope> {
  return new Set<RouteScope>(['concierge']);
}

function telegram(): ReadonlySet<RouteScope> {
  return new Set<RouteScope>(['telegram']);
}

function ops(): ReadonlySet<RouteScope> {
  return new Set<RouteScope>(['ops']);
}
