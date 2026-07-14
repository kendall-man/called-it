/**
 * Typed client for the Called It engine HTTP API — the concierge's only
 * integration surface. The engine owns every validation, price, and lock;
 * this file is transport only. Deliberately imports nothing from the
 * monorepo's workspace packages (see the migration plan: zero workspace deps).
 */

import { loadConciergeEnv } from '../env.js';

const REQUEST_TIMEOUT_MS = 15_000;

export interface EngineMarket {
  marketId: string;
  terms: string;
  currency: 'rep' | 'sol' | 'usdc';
  status: string;
  fixtureId: number;
  isReplay: boolean;
  trustTier: 'chain_proven' | 'oracle_resolved';
  probability: number;
  backers: number;
  doubters: number;
  /** Atomic-unit pot values plus asset-aware display amounts. */
  forAtomic: string;
  againstAtomic: string;
  forAmount: string;
  againstAmount: string;
  /** Legacy SOL fields retained while older clients roll forward. */
  forLamports: string;
  againstLamports: string;
  forSol?: string;
  againstSol?: string;
  /** 0..100 — matched fraction of the total staked pot. */
  matchedPct: number;
  receiptUrl?: string;
}

export interface EngineSnapshot {
  group: { id: number; title: string };
  markets: EngineMarket[];
}

export interface EngineWallet {
  /** null until the member links a devnet wallet with /wallet. */
  linkedWallet: string | null;
  balanceLamports: string;
  balanceSol: string;
  balances: Record<'sol' | 'usdc', {
    availableAtomic: string;
    lockedAtomic: string;
    availableAmount: string;
    lockedAmount: string;
  }>;
  positions: Array<{
    marketId: string;
    terms: string;
    side: 'back' | 'doubt';
    asset: 'sol' | 'usdc';
    stakeAtomic: string;
    stakeAmount: string;
    stakeLamports: string;
    stakeSol?: string;
    state: string;
  }>;
}

export interface EngineQuoteOption {
  key: string;
  label: string;
  terms: string;
  trustTier: 'chain_proven' | 'oracle_resolved';
  fixtureId: number;
  quote:
    | { kind: 'ok'; probability: number; backMultiplier: number; provenance: 'market' | 'modelled' }
    | { kind: 'transient' | 'no_odds' | 'unpriceable' };
}

export interface EngineQuote {
  kind: 'ok' | 'clarify' | 'counter_offer' | 'reject';
  question?: string;
  reason?: string;
  message?: string;
  options?: EngineQuoteOption[];
}

export interface EngineFixture {
  fixtureId: number;
  home: string;
  away: string;
  kickoffAt: string | null;
  phase: string;
  minute: number | null;
}

type EngineRouteScope = 'concierge' | 'telegram';

function config(scope: EngineRouteScope): { readonly base: string; readonly token: string } {
  const env = loadConciergeEnv();
  switch (scope) {
    case 'concierge':
      return {
        base: env.ENGINE_PRIVATE_API_URL.replace(/\/$/, ''),
        token: env.ENGINE_CONCIERGE_TOKEN,
      };
    case 'telegram':
      return {
        base: env.ENGINE_PRIVATE_API_URL.replace(/\/$/, ''),
        token: env.ENGINE_TELEGRAM_TOKEN,
      };
  }
}

function createCaller(scope: EngineRouteScope) {
  return async function call(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const { base, token } = config(scope);
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const parsed = await res.json().catch(() => null);
    if (parsed === null) throw new Error(`engine api ${path} → ${res.status} (no body)`);
    if (!res.ok && res.status !== 422 && res.status !== 404) {
      throw new Error(`engine api ${path} → ${res.status}`);
    }
    return parsed;
  };
}

const call = createCaller('concierge');
const callTelegram = createCaller('telegram');

export async function forwardTelegramUpdate(update: Record<string, unknown>): Promise<void> {
  await callTelegram('POST', '/api/telegram-ingress', update);
}

export const engineApi = {
  snapshot: (chatId: number) => call('GET', `/api/groups/${chatId}/snapshot`),
  wallet: (chatId: number, userId: number) =>
    call('GET', `/api/groups/${chatId}/users/${userId}/wallet`),
  quote: (chatId: number, text: string) =>
    call('POST', '/api/quote', { chatId, text }),
  market: (marketId: string) =>
    call('GET', `/api/markets/${marketId}`),
  fixtures: (hours?: number) =>
    call(
      'GET',
      `/api/fixtures${hours !== undefined ? `?hours=${hours}` : ''}`,
    ),
};

export function telegramIdentity(
  session: unknown,
): { chatId: number; userId: number; username: string | null } | null {
  if (!isRecord(session)) return null;
  const auth = session['auth'];
  if (!isRecord(auth)) return null;
  const current = auth['current'];
  if (!isRecord(current) || current['authenticator'] !== 'telegram-webhook') return null;
  const attributesValue = current['attributes'];
  const attributes = isRecord(attributesValue) ? attributesValue : {};
  const chatId = Number(attributes['chat_id']);
  const userId = Number(attributes['user_id']);
  if (!Number.isFinite(chatId) || !Number.isFinite(userId)) return null;
  const username = attributes['username'];
  return { chatId, userId, username: typeof username === 'string' ? username : null };
}

export const NOT_TELEGRAM: Readonly<{ error: string; hint: string }> = {
  error: 'no_telegram_identity',
  hint: 'This action only works from the Telegram group chat.',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
