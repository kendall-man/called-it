import { z } from 'zod';
import { TXLINE_TUNABLES } from './constants.js';
import { consoleLogger, type TxlineLogger } from './logging.js';
import {
  fixtureRecordSchema,
  oddsRecordSchema,
  oddsValidationResponseSchema,
  scoresRecordSchema,
  statValidationResponseSchema,
  tokenResponseSchema,
  type FixtureRecord,
  type OddsRecord,
  type OddsValidationResponse,
  type ScoresRecord,
  type StatValidationResponse,
} from './schemas.js';

export class TxlineApiError extends Error {
  readonly endpoint: string;
  /** HTTP status, or null for shape/transport failures. */
  readonly status: number | null;

  constructor(endpoint: string, status: number | null, detail: string) {
    const statusPart = status === null ? '' : ` with HTTP ${status}`;
    super(`TxLINE request ${endpoint} failed${statusPart}: ${detail}`);
    this.name = 'TxlineApiError';
    this.endpoint = endpoint;
    this.status = status;
  }
}

export interface TxlineClientOptions {
  /** e.g. https://txline-dev.txodds.com (no trailing slash needed). */
  apiBase: string;
  /** Guest-session JWT from startGuestAuth (expires ~30 days). */
  guestJwt: string;
  /** Long-lived API token from activateToken. */
  apiToken: string;
  /** Injectable for tests; defaults to a late-bound globalThis.fetch. */
  fetchImpl?: typeof fetch;
  logger?: TxlineLogger;
}

export type StreamKind = 'scores' | 'odds';

export interface OpenStreamOptions {
  fixtureId?: number;
  /** Resumes the stream after this event id (SSE Last-Event-ID header). */
  lastEventId?: string | null;
  signal?: AbortSignal;
}

type QueryParams = Record<string, string | number | undefined>;

function trimTrailingSlash(base: string): string {
  return base.endsWith('/') ? base.slice(0, -1) : base;
}

function summarizeZodIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

async function readBodyExcerpt(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, TXLINE_TUNABLES.HTTP_ERROR_BODY_EXCERPT_CHARS);
  } catch {
    return '<unreadable body>';
  }
}

/** Both headers are required on every data endpoint (dual-auth model). */
function dualAuthHeaders(guestJwt: string, apiToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${guestJwt}`,
    'X-Api-Token': apiToken,
  };
}

function buildUrl(apiBase: string, path: string, query?: QueryParams): string {
  const url = new URL(`${trimTrailingSlash(apiBase)}${path}`);
  if (query !== undefined) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/** Late-bound default so test-time stubs of globalThis.fetch take effect. */
const defaultFetch: typeof fetch = (...args) => globalThis.fetch(...args);

export class TxlineClient {
  private readonly apiBase: string;
  private readonly guestJwt: string;
  private readonly apiToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: TxlineLogger;

  constructor(options: TxlineClientOptions) {
    this.apiBase = trimTrailingSlash(options.apiBase);
    this.guestJwt = options.guestJwt;
    this.apiToken = options.apiToken;
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.logger = options.logger ?? consoleLogger;
  }

  async fixturesSnapshot(params?: {
    startEpochDay?: number;
    competitionId?: number;
  }): Promise<FixtureRecord[]> {
    const data = await this.requestJson('/api/fixtures/snapshot', {
      startEpochDay: params?.startEpochDay,
      competitionId: params?.competitionId,
    });
    return this.parseWith(z.array(fixtureRecordSchema), data, '/api/fixtures/snapshot');
  }

  async scoresSnapshot(fixtureId: number, asOfMs?: number): Promise<ScoresRecord[]> {
    const path = `/api/scores/snapshot/${fixtureId}`;
    const data = await this.requestJson(path, { asOf: asOfMs });
    return this.parseWith(z.array(scoresRecordSchema), data, path);
  }

  async oddsSnapshot(fixtureId: number, asOfMs?: number): Promise<OddsRecord[]> {
    const path = `/api/odds/snapshot/${fixtureId}`;
    const data = await this.requestJson(path, { asOf: asOfMs });
    return this.parseWith(z.array(oddsRecordSchema), data, path);
  }

  async statValidation(
    fixtureId: number,
    seq: number,
    statKey: number,
    statKey2?: number,
  ): Promise<StatValidationResponse> {
    const path = '/api/scores/stat-validation';
    const data = await this.requestJson(path, { fixtureId, seq, statKey, statKey2 });
    return this.parseWith(statValidationResponseSchema, data, path);
  }

  async oddsValidation(messageId: string, tsMs: number): Promise<OddsValidationResponse> {
    const path = '/api/odds/validation';
    const data = await this.requestJson(path, { messageId, ts: tsMs });
    return this.parseWith(oddsValidationResponseSchema, data, path);
  }

  /**
   * Opens one of the SSE endpoints and returns the raw Response (body is a
   * ReadableStream of text/event-stream bytes). Used by LiveSource.
   */
  async openStream(kind: StreamKind, options: OpenStreamOptions = {}): Promise<Response> {
    const path = kind === 'scores' ? '/api/scores/stream' : '/api/odds/stream';
    const url = buildUrl(this.apiBase, path, { fixtureId: options.fixtureId });
    const headers: Record<string, string> = {
      ...dualAuthHeaders(this.guestJwt, this.apiToken),
      Accept: 'text/event-stream',
    };
    if (options.lastEventId !== undefined && options.lastEventId !== null) {
      headers['Last-Event-ID'] = options.lastEventId;
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers, signal: options.signal });
    } catch (error) {
      throw new TxlineApiError(path, null, `network error: ${String(error)}`);
    }
    if (!res.ok) {
      throw new TxlineApiError(path, res.status, await readBodyExcerpt(res));
    }
    if (res.body === null) {
      throw new TxlineApiError(path, res.status, 'response has no body stream');
    }
    return res;
  }

  private async requestJson(path: string, query?: QueryParams): Promise<unknown> {
    const url = buildUrl(this.apiBase, path, query);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { ...dualAuthHeaders(this.guestJwt, this.apiToken), Accept: 'application/json' },
      });
    } catch (error) {
      throw new TxlineApiError(path, null, `network error: ${String(error)}`);
    }
    if (!res.ok) {
      throw new TxlineApiError(path, res.status, await readBodyExcerpt(res));
    }
    try {
      return await res.json();
    } catch (error) {
      throw new TxlineApiError(path, res.status, `body is not valid JSON: ${String(error)}`);
    }
  }

  private parseWith<Schema extends z.ZodTypeAny>(
    schema: Schema,
    data: unknown,
    endpoint: string,
  ): z.infer<Schema> {
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      this.logger('unexpected response shape', { endpoint });
      throw new TxlineApiError(
        endpoint,
        null,
        `unexpected response shape — ${summarizeZodIssues(parsed.error)}`,
      );
    }
    return parsed.data;
  }
}

// ── Auth helpers ──────────────────────────────────────────────────────────

/** POST /auth/guest/start — anonymous guest session, JWT valid ~30 days. */
export async function startGuestAuth(
  apiBase: string,
  fetchImpl: typeof fetch = defaultFetch,
): Promise<{ jwt: string }> {
  const path = '/auth/guest/start';
  const url = buildUrl(apiBase, path);
  let res: Response;
  try {
    res = await fetchImpl(url, { method: 'POST', headers: { Accept: 'application/json' } });
  } catch (error) {
    throw new TxlineApiError(path, null, `network error: ${String(error)}`);
  }
  if (!res.ok) throw new TxlineApiError(path, res.status, await readBodyExcerpt(res));
  let data: unknown;
  try {
    data = await res.json();
  } catch (error) {
    throw new TxlineApiError(path, res.status, `body is not valid JSON: ${String(error)}`);
  }
  const parsed = tokenResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new TxlineApiError(path, null, `unexpected response shape — ${summarizeZodIssues(parsed.error)}`);
  }
  return { jwt: parsed.data.token };
}

/**
 * POST /api/token/activate — exchanges the confirmed on-chain subscribe txSig
 * plus a wallet signature (ed25519-detached over `${txSig}:${leagues}:${jwt}`,
 * produced by @calledit/solana signActivation) for the long-lived API token.
 * The 200 response is text/plain per the spec; a JSON-wrapped token is
 * tolerated defensively.
 */
export async function activateToken(
  apiBase: string,
  jwt: string,
  txSig: string,
  walletSignatureB64: string,
  leagues: number[],
  fetchImpl: typeof fetch = defaultFetch,
): Promise<{ apiToken: string }> {
  const path = '/api/token/activate';
  const url = buildUrl(apiBase, path);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ txSig, walletSignature: walletSignatureB64, leagues }),
    });
  } catch (error) {
    throw new TxlineApiError(path, null, `network error: ${String(error)}`);
  }
  if (!res.ok) throw new TxlineApiError(path, res.status, await readBodyExcerpt(res));
  const text = (await res.text()).trim();
  const apiToken = extractToken(text);
  if (apiToken === null || apiToken.length === 0) {
    throw new TxlineApiError(path, res.status, `activation returned an empty token (body: ${text.slice(0, 80)})`);
  }
  return { apiToken };
}

/** Accepts a bare token, a JSON string literal, or {"token": "..."}. */
function extractToken(text: string): string | null {
  if (text.startsWith('{') || text.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === 'string') return parsed;
      const asObject = tokenResponseSchema.safeParse(parsed);
      if (asObject.success) return asObject.data.token;
      return null;
    } catch {
      return text;
    }
  }
  return text;
}
