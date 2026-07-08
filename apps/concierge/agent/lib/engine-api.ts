/**
 * Typed client for the Called It engine HTTP API — the concierge's only
 * integration surface. The engine owns every validation, price, and lock;
 * this file is transport only. Deliberately imports nothing from the
 * monorepo's workspace packages (see the migration plan: zero workspace deps).
 */

const REQUEST_TIMEOUT_MS = 15_000;

export interface EngineMarket {
  marketId: string;
  terms: string;
  currency: 'sol';
  status: string;
  fixtureId: number;
  isReplay: boolean;
  trustTier: 'chain_proven' | 'oracle_resolved';
  probability: number;
  backers: number;
  doubters: number;
  /** For/Against pots, lamports as decimal strings and human SOL. */
  forLamports: string;
  againstLamports: string;
  forSol: string;
  againstSol: string;
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
  positions: Array<{
    marketId: string;
    terms: string;
    side: 'back' | 'doubt';
    stakeLamports: string;
    stakeSol: string;
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

export type EngineStakeResult =
  /** 200: the stake reached the wager desk; `reply` explains it (placed,
   * idempotent replay, insufficient balance, paused, …). Relay `reply`. */
  | { placed: boolean; reply: string }
  /** 404/409/503: the market was unknown, closed, or the desk is down. */
  | { error: string; status?: string };

export interface EngineFixture {
  fixtureId: number;
  home: string;
  away: string;
  kickoffAt: string | null;
  phase: string;
  minute: number | null;
}

function config(): { base: string; token: string } {
  const base = process.env.ENGINE_API_URL;
  const token = process.env.ENGINE_API_TOKEN;
  if (!base || !token) {
    throw new Error('engine api not configured: set ENGINE_API_URL and ENGINE_API_TOKEN');
  }
  return { base: base.replace(/\/$/, ''), token };
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const { base, token } = config();
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // Engine guard rejections (422) and stake conflicts (409) carry structured
  // JSON the tools relay to the model — only transport-level failures throw.
  const parsed = (await res.json().catch(() => null)) as T | null;
  if (parsed === null) throw new Error(`engine api ${path} → ${res.status} (no body)`);
  if (!res.ok && res.status !== 409 && res.status !== 422 && res.status !== 404) {
    throw new Error(`engine api ${path} → ${res.status}: ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  return parsed;
}

/**
 * Single-ingress forwarding: hand a raw Telegram update to the engine so its
 * grammY handlers (claim detection, commands, card buttons) process it exactly
 * as if it had been polled. Fire-and-forget semantics; the engine acks fast.
 */
export async function forwardTelegramUpdate(update: Record<string, unknown>): Promise<void> {
  await call<{ ok: boolean }>('POST', '/api/telegram-update', update);
}

export const engineApi = {
  snapshot: (chatId: number) => call<EngineSnapshot>('GET', `/api/groups/${chatId}/snapshot`),
  wallet: (chatId: number, userId: number) =>
    call<EngineWallet>('GET', `/api/groups/${chatId}/users/${userId}/wallet`),
  quote: (chatId: number, text: string) =>
    call<EngineQuote>('POST', '/api/quote', { chatId, text }),
  stake: (input: {
    chatId: number;
    marketId: string;
    userId: number;
    displayName: string;
    username: string | null;
    side: 'back' | 'doubt';
    amount: number;
    idempotencyKey: string;
  }) => call<EngineStakeResult>('POST', '/api/stake', input),
  market: (marketId: string) =>
    call<EngineMarket | { error: string }>('GET', `/api/markets/${marketId}`),
  fixtures: (hours?: number) =>
    call<{ fixtures: EngineFixture[] }>(
      'GET',
      `/api/fixtures${hours !== undefined ? `?hours=${hours}` : ''}`,
    ),
};

/**
 * Trusted Telegram identity — read from the session auth principal the
 * Telegram channel derived from the WEBHOOK payload, never from anything the
 * model wrote. This is the N4 invariant: nobody can stake as someone else by
 * naming them.
 */
export function telegramIdentity(
  session: unknown,
): { chatId: number; userId: number; username: string | null } | null {
  const current = (
    session as {
      auth?: { current?: { authenticator?: string; attributes?: Record<string, unknown> } };
    }
  )?.auth?.current;
  if (!current || current.authenticator !== 'telegram-webhook') return null;
  const attributes = current.attributes ?? {};
  const chatId = Number(attributes['chat_id']);
  const userId = Number(attributes['user_id']);
  if (!Number.isFinite(chatId) || !Number.isFinite(userId)) return null;
  const username = attributes['username'];
  return { chatId, userId, username: typeof username === 'string' ? username : null };
}

/** Uniform reply when a tool runs outside a Telegram group session. */
export const NOT_TELEGRAM = {
  error: 'no_telegram_identity',
  hint: 'This action only works from the Telegram group chat.',
} as const;
