/**
 * The HTTP surface: the TxLINE API endpoints the engine's TxlineClient +
 * LiveSource + ReplaySource actually call, plus a /mock director API for
 * scheduling matches. Auth headers are accepted and ignored — this server
 * only ever runs on localhost/staging.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { MOCKLINE } from './constants.js';
import { parseCursor, type MatchStore, type StreamKind } from './store.js';
import type { MatchScript } from './types.js';

interface MocklineServerOptions {
  store: MatchStore;
  scripts: ReadonlyMap<string, MatchScript>;
  defaultScriptKey: string;
  log?: (message: string, context?: Record<string, unknown>) => void;
  heartbeatMs?: number;
  pumpIntervalMs?: number;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;
const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
} as const;

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function asOfFrom(url: URL): number | undefined {
  const raw = url.searchParams.get('asOf');
  if (raw === null) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Synthetic-but-mappable stat-validation envelope (see proofs/mapping.ts). */
function statValidationEnvelope(fixtureId: number, seq: number, statKey: number): unknown {
  const MOCK_ROOT = `0x${'ab'.repeat(32)}`;
  const nowMs = Date.now();
  return {
    ts: nowMs,
    summary: {
      fixtureId,
      updateStats: { minTimestamp: nowMs, maxTimestamp: nowMs, count: 1 },
      eventStatsSubTreeRoot: MOCK_ROOT,
    },
    statToProve: { fixtureId, seq, statKey, mock: true },
    eventStatRoot: MOCK_ROOT,
    statProof: [],
    subTreeProof: [],
    mainTreeProof: [],
  };
}

export function createMocklineServer(options: MocklineServerOptions): Server {
  const { store, scripts, defaultScriptKey } = options;
  const log = options.log ?? (() => undefined);
  const heartbeatMs = options.heartbeatMs ?? MOCKLINE.HEARTBEAT_MS;
  const pumpIntervalMs = options.pumpIntervalMs ?? MOCKLINE.PUMP_INTERVAL_MS;

  function openStream(kind: StreamKind, url: URL, req: IncomingMessage, res: ServerResponse): void {
    const fixtureParam = url.searchParams.get('fixtureId');
    const fixtureId = fixtureParam === null ? undefined : Number(fixtureParam);
    let cursor = parseCursor(
      (req.headers['last-event-id'] as string | undefined) ?? null,
    );
    res.writeHead(200, SSE_HEADERS);
    res.write(': mockline stream open\n\n');

    const pushFresh = (): void => {
      for (const frame of store.framesSince(kind, fixtureId, cursor)) {
        res.write(`id: ${frame.id}\ndata: ${frame.data}\n\n`);
        cursor = { wallTs: frame.wallTs, ordinal: frame.ordinal };
      }
    };
    pushFresh();

    const pump = setInterval(pushFresh, pumpIntervalMs);
    const heartbeat = setInterval(() => {
      res.write(`event: heartbeat\ndata: {"Ts":${Date.now()}}\n\n`);
    }, heartbeatMs);
    req.on('close', () => {
      clearInterval(pump);
      clearInterval(heartbeat);
    });
    log('stream_opened', { kind, fixtureId: fixtureId ?? 'all' });
  }

  async function handleMockControl(
    path: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    if (path === '/mock/status' && req.method === 'GET') {
      sendJson(res, 200, { matches: store.status(), scripts: [...scripts.keys()] });
      return true;
    }
    if (path === '/mock/schedule' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const scriptKey = typeof body.script === 'string' ? body.script : defaultScriptKey;
      const script = scripts.get(scriptKey);
      if (!script) {
        sendJson(res, 404, { error: `unknown script "${scriptKey}"`, scripts: [...scripts.keys()] });
        return true;
      }
      const inMinutes =
        typeof body.inMinutes === 'number' && body.inMinutes >= 0
          ? body.inMinutes
          : MOCKLINE.DEFAULT_KICKOFF_LEAD_MIN;
      const timeScale =
        typeof body.timeScale === 'number' && body.timeScale >= 1
          ? body.timeScale
          : MOCKLINE.DEFAULT_TIME_SCALE;
      const MS_PER_MINUTE = 60_000;
      const match = store.scheduleLive(script, inMinutes * MS_PER_MINUTE, timeScale);
      log('match_scheduled', { fixtureId: match.fixtureId, scriptKey, inMinutes, timeScale });
      sendJson(res, 200, {
        fixtureId: match.fixtureId,
        label: `${script.home.name} vs ${script.away.name}`,
        kickoffAt: new Date(match.kickoffWallMs).toISOString(),
        timeScale,
        note:
          'The engine syncs fixtures every 15 min (and at boot). Schedule with ' +
          '{"inMinutes": 20} for hands-off pickup, or restart the engine to sync now.',
      });
      return true;
    }
    if (path === '/mock/finished' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const scriptKey = typeof body.script === 'string' ? body.script : defaultScriptKey;
      const script = scripts.get(scriptKey);
      if (!script) {
        sendJson(res, 404, { error: `unknown script "${scriptKey}"`, scripts: [...scripts.keys()] });
        return true;
      }
      const fixtureId =
        typeof body.fixtureId === 'number' ? body.fixtureId : MOCKLINE.REPLAY_FIXTURE_ID;
      const match = store.scheduleFinished(script, fixtureId);
      log('finished_match_scheduled', { fixtureId: match.fixtureId, scriptKey });
      sendJson(res, 200, {
        fixtureId: match.fixtureId,
        label: `${script.home.name} vs ${script.away.name}`,
        note: `Finished match ready — run /replay ${match.fixtureId} in the group.`,
      });
      return true;
    }
    if (path === '/mock/reset' && req.method === 'POST') {
      store.reset();
      sendJson(res, 200, { ok: true });
      return true;
    }
    return false;
  }

  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://mockline.local');
      const path = url.pathname;

      // ── Auth endpoints (bootstrap parity; values are fixed) ──────────────
      if (path === '/auth/guest/start' && req.method === 'POST') {
        sendJson(res, 200, { token: MOCKLINE.MOCK_GUEST_JWT });
        return;
      }
      if (path === '/api/token/activate' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(MOCKLINE.MOCK_API_TOKEN);
        return;
      }

      // ── TxLINE data surface ──────────────────────────────────────────────
      if (path === '/api/fixtures/snapshot') {
        sendJson(res, 200, store.fixtures());
        return;
      }
      const scoresSnapshot = path.match(/^\/api\/scores\/snapshot\/(\d+)$/);
      if (scoresSnapshot?.[1] !== undefined) {
        sendJson(res, 200, store.scoresSnapshot(Number(scoresSnapshot[1]), asOfFrom(url)));
        return;
      }
      const oddsSnapshot = path.match(/^\/api\/odds\/snapshot\/(\d+)$/);
      if (oddsSnapshot?.[1] !== undefined) {
        sendJson(res, 200, store.oddsSnapshot(Number(oddsSnapshot[1]), asOfFrom(url)));
        return;
      }
      if (path === '/api/scores/stream') {
        openStream('scores', url, req, res);
        return;
      }
      if (path === '/api/odds/stream') {
        openStream('odds', url, req, res);
        return;
      }
      if (path === '/api/scores/stat-validation') {
        const fixtureId = Number(url.searchParams.get('fixtureId') ?? 0);
        const seq = Number(url.searchParams.get('seq') ?? 0);
        const statKey = Number(url.searchParams.get('statKey') ?? 0);
        sendJson(res, 200, statValidationEnvelope(fixtureId, seq, statKey));
        return;
      }
      if (path === '/api/odds/validation') {
        sendJson(res, 200, { odds: { mock: true }, summary: { mock: true }, subTreeProof: [], mainTreeProof: [] });
        return;
      }

      // ── Director controls ────────────────────────────────────────────────
      if (await handleMockControl(path, req, res)) return;

      if (path === '/') {
        sendJson(res, 200, {
          service: 'mockline',
          hint: 'GET /mock/status · POST /mock/schedule {script?, inMinutes?, timeScale?} · POST /mock/finished {script?} · POST /mock/reset',
        });
        return;
      }
      sendJson(res, 404, { error: `no route for ${req.method} ${path}` });
    })().catch((error: unknown) => {
      log('request_failed', { error: String(error) });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
  });
}
