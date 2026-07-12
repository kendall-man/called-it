import { z } from 'zod';
import { bindAbortSignalToFetch, cancelUnusedResponse } from './readiness-http.js';

const LIVE_PRICING_PHASES = ['H1', 'HT', 'H2', 'ET1', 'HTET', 'ET2', 'PE', 'INT'];
const FixtureRows = z.array(z.object({ fixture_id: z.number().int() }));
const ProbeRows = z.array(z.object({ last_event_id: z.string().nullable() }));
const WagerStatusRows = z.array(
  z.object({ paused: z.boolean(), reason: z.string().nullable() }),
);
const DatabaseInteger = z.union([
  z.bigint(),
  z.number().int().nonnegative(),
  z.string().regex(/^\d+$/),
]).transform((value) => BigInt(value));
const StarterBudgetRows = z.array(z.object({
  enabled: z.boolean(),
  grant_lamports: DatabaseInteger,
  total_cap_lamports: DatabaseInteger,
  max_grants: DatabaseInteger,
  granted_lamports: DatabaseInteger,
  granted_count: DatabaseInteger,
}));

export interface SupabaseReadinessStatus {
  readonly paused: boolean;
  readonly reason: string | null;
}

export interface SupabaseStarterBudgetStatus {
  readonly enabled: boolean;
  readonly available: boolean;
}

export interface SupabaseReadinessClient {
  probe(signal: AbortSignal): Promise<void>;
  liveFixtureIds(
    nowMs: number,
    lookaheadMs: number,
    signal: AbortSignal,
  ): Promise<readonly number[]>;
  wagerStatus(signal: AbortSignal): Promise<SupabaseReadinessStatus>;
  starterBudget(signal: AbortSignal): Promise<SupabaseStarterBudgetStatus>;
}

export interface SupabaseReadinessClientOptions {
  readonly baseUrl: string;
  readonly serviceRoleKey: string;
  readonly request?: typeof fetch;
}

function tableUrl(
  baseUrl: string,
  table: string,
  query: Readonly<Record<string, string>>,
): URL {
  const url = new URL(`/rest/v1/${table}`, baseUrl);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return url;
}

async function requestJson(
  options: SupabaseReadinessClientOptions,
  url: URL,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  const request = bindAbortSignalToFetch(options.request ?? globalThis.fetch, signal);
  const response = await request(url, {
    headers: {
      accept: 'application/json',
      apikey: options.serviceRoleKey,
      authorization: `Bearer ${options.serviceRoleKey}`,
    },
  });
  if (!response.ok) {
    await cancelUnusedResponse(response);
    throw new Error('supabase readiness request failed');
  }
  const body = await response.json();
  signal.throwIfAborted();
  return body;
}

export function createSupabaseReadinessClient(
  options: SupabaseReadinessClientOptions,
): SupabaseReadinessClient {
  return {
    async probe(signal) {
      const body = await requestJson(
        options,
        tableUrl(options.baseUrl, 'stream_cursors', {
          select: 'last_event_id',
          limit: '1',
        }),
        signal,
      );
      ProbeRows.parse(body);
      signal.throwIfAborted();
    },
    async liveFixtureIds(nowMs, lookaheadMs, signal) {
      const windowStart = new Date(nowMs - lookaheadMs).toISOString();
      const windowEnd = new Date(nowMs + lookaheadMs).toISOString();
      const orFilter =
        `(phase.in.(${LIVE_PRICING_PHASES.join(',')}),` +
        `and(phase.eq.NS,kickoff_at.gte.${windowStart},kickoff_at.lte.${windowEnd}))`;
      const body = await requestJson(
        options,
        tableUrl(options.baseUrl, 'fixtures', {
          select: 'fixture_id',
          or: orFilter,
        }),
        signal,
      );
      const rows = FixtureRows.parse(body);
      signal.throwIfAborted();
      return rows.map((row) => row.fixture_id);
    },
    async wagerStatus(signal) {
      const body = await requestJson(
        options,
        tableUrl(options.baseUrl, 'wager_status', {
          select: 'paused,reason',
          id: 'eq.1',
          limit: '1',
        }),
        signal,
      );
      const row = WagerStatusRows.parse(body)[0];
      signal.throwIfAborted();
      if (row === undefined) throw new Error('wager readiness status missing');
      return row;
    },
    async starterBudget(signal) {
      const body = await requestJson(
        options,
        tableUrl(options.baseUrl, 'wager_starter_budget', {
          select:
            'enabled,grant_lamports,total_cap_lamports,max_grants,granted_lamports,granted_count',
          id: 'eq.1',
          limit: '1',
        }),
        signal,
      );
      const row = StarterBudgetRows.parse(body)[0];
      signal.throwIfAborted();
      if (row === undefined) throw new Error('starter budget readiness row missing');
      return {
        enabled: row.enabled,
        available:
          row.enabled
          && row.granted_count < row.max_grants
          && row.granted_lamports + row.grant_lamports <= row.total_cap_lamports,
      };
    },
  };
}
