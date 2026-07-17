import { z } from 'zod';
import type { ServerResponse } from 'node:http';
import type { Logger } from '../log.js';
import type { EngineDb } from '../ports.js';
import type { SolanaNetwork } from '../solana-network.js';
import type {
  EscrowPlacementRejectionCode,
  EscrowTelegramPort,
} from '../bot/escrow-ux.js';
import { presetStakes } from '../wager/constants.js';
import { sendJson } from './server-http.js';

const POSITION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SOLANA_PUBKEY_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64_TRANSACTION_PATTERN = /^[A-Za-z0-9+/]{1,4094}={0,2}$/;
const SOLANA_SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,128}$/;
const REJECTION_CODE_PATTERN = /^[a-z][a-z0-9_]{0,79}$/;

export const EscrowPositionAcceptInputSchema = z.object({
  token: z.string().regex(POSITION_TOKEN_PATTERN),
  telegramUserId: z.number().int().positive().safe(),
  privyUserId: z.string().min(1).max(255),
  privyWalletId: z.string().min(1).max(255),
  ownerPubkey: z.string().regex(SOLANA_PUBKEY_PATTERN),
  marketId: z.string().regex(UUID_PATTERN),
  rawTransactionBase64: z.string().max(4096).regex(BASE64_TRANSACTION_PATTERN),
}).strict();

export interface EscrowPositionAcceptInput {
  readonly token: string;
  readonly telegramUserId: number;
  readonly privyUserId: string;
  readonly privyWalletId: string;
  readonly ownerPubkey: string;
  readonly marketId: string;
  readonly rawTransactionBase64: string;
}

export type EscrowPositionAcceptResult =
  | {
      readonly kind: 'accepted';
      readonly duplicate: boolean;
      readonly jobCreated: boolean;
      readonly signature: string;
    }
  | { readonly kind: 'rejected'; readonly code: string };

export interface EscrowPositionAcceptApi {
  accept(input: EscrowPositionAcceptInput): Promise<EscrowPositionAcceptResult>;
}

const EscrowPositionAcceptResultSchema = z.union([
  z.object({
    kind: z.literal('accepted'),
    duplicate: z.boolean(),
    jobCreated: z.boolean(),
    signature: z.string().regex(SOLANA_SIGNATURE_PATTERN),
  }).strict(),
  z.object({
    kind: z.literal('rejected'),
    code: z.string().regex(REJECTION_CODE_PATTERN),
  }).strict(),
]);

function rejectedStatus(code: string): number {
  switch (code) {
    case 'invalid_input':
      return 400;
    case 'session_not_found':
      return 404;
    case 'temporarily_unavailable':
      return 503;
    default:
      return 409;
  }
}

export async function handleEscrowPositionAccept(input: {
  readonly body: unknown;
  readonly custodyMode: 'legacy' | 'escrow';
  readonly api: EscrowPositionAcceptApi | undefined;
  readonly log: Logger;
  readonly res: ServerResponse;
}): Promise<void> {
  if (input.custodyMode !== 'escrow') {
    sendJson(input.res, 409, { kind: 'rejected', code: 'unavailable_mode' });
    return;
  }
  if (input.api === undefined) {
    sendJson(input.res, 503, { kind: 'rejected', code: 'temporarily_unavailable' });
    return;
  }
  const parsed = EscrowPositionAcceptInputSchema.safeParse(input.body);
  if (!parsed.success) {
    sendJson(input.res, 400, { kind: 'rejected', code: 'invalid_input' });
    return;
  }
  try {
    const result = EscrowPositionAcceptResultSchema.safeParse(await input.api.accept(parsed.data));
    if (!result.success) {
      input.log.error('escrow_position_accept_invalid_response');
      sendJson(input.res, 503, { kind: 'rejected', code: 'temporarily_unavailable' });
      return;
    }
    if (result.data.kind === 'accepted') {
      sendJson(input.res, 202, result.data);
      return;
    }
    sendJson(input.res, rejectedStatus(result.data.code), result.data);
  } catch (error) {
    input.log.warn('escrow_position_accept_failed', {
      reason: error instanceof Error ? 'accept_exception' : 'unknown_exception',
    });
    sendJson(input.res, 503, { kind: 'rejected', code: 'temporarily_unavailable' });
  }
}

/*
 * Mini App session routes — shared contract with apps/web. The web bridge
 * verified Telegram initData before calling, so telegramUserId carries the
 * same trust as on /api/escrow/positions/accept. Session tokens are returned
 * to the bridge only and must never be logged or posted to a group surface.
 */

/** Contract: sha256 hex of the web-side idempotency recipe. */
const SESSION_IDEMPOTENCY_KEY_PATTERN = /^[0-9a-f]{64}$/;
const TELEGRAM_USERNAME_MAX_LENGTH = 64;
const SESSION_CREATES_PER_USER_PER_WINDOW = 6;
const SESSION_RATE_WINDOW_MS = 60_000;
/** The Mini App exposes only the first preset (0.01 SOL / 1 USDC). */
const MINIAPP_AMOUNT_PRESET_INDEX = 0;

export const EscrowPositionSessionInputSchema = z.object({
  marketId: z.string().regex(UUID_PATTERN),
  side: z.enum(['back', 'against']),
  amountPreset: z.literal(MINIAPP_AMOUNT_PRESET_INDEX),
  telegramUserId: z.number().int().positive().safe(),
  telegramUsername: z.string().min(1).max(TELEGRAM_USERNAME_MAX_LENGTH).optional(),
  idempotencyKey: z.string().regex(SESSION_IDEMPOTENCY_KEY_PATTERN),
}).strict();

export const EscrowWalletSessionInputSchema = z.object({
  telegramUserId: z.number().int().positive().safe(),
  telegramUsername: z.string().min(1).max(TELEGRAM_USERNAME_MAX_LENGTH).optional(),
  idempotencyKey: z.string().regex(SESSION_IDEMPOTENCY_KEY_PATTERN),
}).strict();

export interface EscrowSessionRateLimiter {
  allow(telegramUserId: number): boolean;
}

/** Sliding one-minute window per Telegram user; state is process-local. */
export function createEscrowSessionRateLimiter(now: () => number): EscrowSessionRateLimiter {
  const recentByUser = new Map<number, number[]>();
  let lastSweepAtMs = 0;
  return {
    allow(telegramUserId) {
      const nowMs = now();
      const cutoff = nowMs - SESSION_RATE_WINDOW_MS;
      if (nowMs - lastSweepAtMs > SESSION_RATE_WINDOW_MS) {
        // Bound memory: drop users whose whole window has expired.
        for (const [userId, attempts] of recentByUser) {
          if (attempts.every((at) => at <= cutoff)) recentByUser.delete(userId);
        }
        lastSweepAtMs = nowMs;
      }
      const recent = (recentByUser.get(telegramUserId) ?? []).filter((at) => at > cutoff);
      if (recent.length >= SESSION_CREATES_PER_USER_PER_WINDOW) {
        recentByUser.set(telegramUserId, recent);
        return false;
      }
      recent.push(nowMs);
      recentByUser.set(telegramUserId, recent);
      return true;
    },
  };
}

export type EscrowSessionUserStore = Pick<EngineDb, 'getUser' | 'upsertUser'>;

/**
 * A URL-button tap produces no Telegram update, so the session may be the
 * user's first touch. Insert-if-absent keeps FK integrity without clobbering
 * an existing display name.
 */
async function ensureSessionUser(
  db: EscrowSessionUserStore,
  telegramUserId: number,
  telegramUsername: string | undefined,
): Promise<void> {
  const existing = await db.getUser(telegramUserId);
  if (existing !== null) return;
  await db.upsertUser({
    id: telegramUserId,
    display_name: telegramUsername ?? 'Player',
    username: telegramUsername ?? null,
  });
}

type PlacementSessionErrorCode =
  | 'wallet_required'
  | 'market_not_found'
  | 'market_closed'
  | 'positions_paused'
  | 'rate_limited'
  | 'invalid_request';

function placementSessionErrorStatus(code: PlacementSessionErrorCode): number {
  switch (code) {
    case 'invalid_request':
      return 400;
    case 'market_not_found':
      return 404;
    case 'rate_limited':
      return 429;
    default:
      return 409;
  }
}

function sendSessionError(res: ServerResponse, code: PlacementSessionErrorCode): void {
  sendJson(res, placementSessionErrorStatus(code), { error: code });
}

function sendSessionUnavailable(res: ServerResponse): void {
  sendJson(res, 503, { error: 'temporarily_unavailable' });
}

/** Collapse the creator's rejection taxonomy into the shared route contract. */
function mappedPlacementRejection(
  code: EscrowPlacementRejectionCode,
): PlacementSessionErrorCode | null {
  switch (code) {
    case 'wallet_required':
      return 'wallet_required';
    case 'market_closed':
      return 'market_closed';
    case 'paused':
      return 'positions_paused';
    case 'amount_out_of_range':
      return 'invalid_request';
    // Transient creator states (stale blockhash, service blips) are 503s so
    // the Mini App retries instead of treating them as contract errors.
    case 'callback_expired':
    case 'temporarily_unavailable':
      return null;
  }
}

export interface EscrowSessionRouteDeps {
  readonly custodyMode: 'legacy' | 'escrow';
  /** The same port the group-tap DM flow uses; wallet lookup included. */
  readonly sessions: EscrowTelegramPort | undefined;
  readonly network: SolanaNetwork;
  readonly markets: Pick<EngineDb, 'getMarket'>;
  readonly users: EscrowSessionUserStore;
  readonly rateLimiter: EscrowSessionRateLimiter;
  readonly log: Logger;
}

export async function handleEscrowPositionSession(input: {
  readonly body: unknown;
  readonly deps: EscrowSessionRouteDeps;
  readonly res: ServerResponse;
}): Promise<void> {
  const { deps, res } = input;
  if (deps.custodyMode !== 'escrow' || deps.sessions === undefined) {
    sendSessionUnavailable(res);
    return;
  }
  const parsed = EscrowPositionSessionInputSchema.safeParse(input.body);
  if (!parsed.success) {
    sendSessionError(res, 'invalid_request');
    return;
  }
  const request = parsed.data;
  const market = await deps.markets.getMarket(request.marketId);
  if (market === null || (market.currency !== 'sol' && market.currency !== 'usdc')) {
    sendSessionError(res, 'market_not_found');
    return;
  }
  const asset: 'sol' | 'usdc' = market.currency;
  if (market.status !== 'open' && market.status !== 'pending_lineup') {
    sendSessionError(res, 'market_closed');
    return;
  }
  if (!deps.rateLimiter.allow(request.telegramUserId)) {
    sendSessionError(res, 'rate_limited');
    return;
  }
  try {
    await ensureSessionUser(deps.users, request.telegramUserId, request.telegramUsername);
    const amountAtomic = presetStakes(asset)[MINIAPP_AMOUNT_PRESET_INDEX];
    const result = await deps.sessions.createPlacementSession({
      idempotencyKey: request.idempotencyKey,
      telegramUserId: request.telegramUserId,
      groupId: market.group_id,
      marketId: market.id,
      side: request.side === 'back' ? 'back' : 'doubt',
      asset,
      amountAtomic,
      network: deps.network,
      replay: market.is_replay,
    });
    if (result.kind === 'rejected') {
      deps.log.info('escrow_miniapp_position_session_rejected', { code: result.code });
      const mapped = mappedPlacementRejection(result.code);
      if (mapped === null) sendSessionUnavailable(res);
      else sendSessionError(res, mapped);
      return;
    }
    sendJson(res, 200, { token: result.token, expiresAtIso: result.expiresAt });
  } catch (error) {
    deps.log.warn('escrow_miniapp_position_session_failed', {
      reason: error instanceof Error ? 'session_exception' : 'unknown_exception',
    });
    sendSessionUnavailable(res);
  }
}

export async function handleEscrowWalletSession(input: {
  readonly body: unknown;
  readonly deps: EscrowSessionRouteDeps;
  readonly res: ServerResponse;
}): Promise<void> {
  const { deps, res } = input;
  if (deps.custodyMode !== 'escrow' || deps.sessions === undefined) {
    sendSessionUnavailable(res);
    return;
  }
  const parsed = EscrowWalletSessionInputSchema.safeParse(input.body);
  if (!parsed.success) {
    sendSessionError(res, 'invalid_request');
    return;
  }
  const request = parsed.data;
  if (!deps.rateLimiter.allow(request.telegramUserId)) {
    sendSessionError(res, 'rate_limited');
    return;
  }
  try {
    await ensureSessionUser(deps.users, request.telegramUserId, request.telegramUsername);
    const result = await deps.sessions.createWalletSession({
      telegramUserId: request.telegramUserId,
      idempotencyKey: request.idempotencyKey,
    });
    if (result.kind === 'rejected') {
      deps.log.info('escrow_miniapp_wallet_session_rejected', { code: result.code });
      sendSessionUnavailable(res);
      return;
    }
    sendJson(res, 200, { token: result.token, expiresAtIso: result.expiresAt });
  } catch (error) {
    deps.log.warn('escrow_miniapp_wallet_session_failed', {
      reason: error instanceof Error ? 'session_exception' : 'unknown_exception',
    });
    sendSessionUnavailable(res);
  }
}
