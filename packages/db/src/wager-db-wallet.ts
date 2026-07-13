import { DbError, unwrapRows } from './errors.js';
import {
  isUuid,
  lamportsFromDb,
  lamportsToDb,
} from './wager-db-core.js';
import type { WagerDb, WagerDbClient } from './wager-db-contract.js';
import { parsePendingStakeIntentRow } from './wager-db-row-parsers.js';
import type {
  CreatePendingStakeIntentResult,
  MutatePendingStakeIntentResult,
  PendingStakeIntentErrorCode,
  PendingStakeIntentState,
  ResolvePendingStakeIntentResult,
  VerifiedWalletLinkErrorCode,
  VerifiedWalletLinkResult,
  WalletLinkSessionResult,
} from './wager-types.js';

type WalletDb = Pick<
  WagerDb,
  | 'verifyWalletLink'
  | 'createWalletLinkSession'
  | 'createPendingStakeIntent'
  | 'resolveActiveStakeIntent'
  | 'markStakeIntentFunded'
  | 'consumeReadyStakeIntent'
  | 'cancelStakeIntent'
>;

const WALLET_LINK_CODES: ReadonlySet<unknown> = new Set<VerifiedWalletLinkErrorCode>([
  'challenge_invalid',
  'challenge_expired',
  'pubkey_reserved',
  'balance_nonzero',
  'positions_open',
  'withdrawal_pending',
]);

const INTENT_CODES: ReadonlySet<unknown> = new Set<PendingStakeIntentErrorCode>([
  'field_mismatch',
  'active_intent_exists',
  'expired',
  'not_found',
  'not_ready',
]);

const INTENT_STATES: ReadonlySet<unknown> = new Set<PendingStakeIntentState>([
  'pending',
  'awaiting_funds',
  'ready',
  'consumed',
  'expired',
  'cancelled',
]);

export function walletDbMethods(client: WagerDbClient): WalletDb {
  return {
    async createWalletLinkSession(args) {
      const payload = unwrapRows<unknown>(
        'wager_create_wallet_link_session',
        await client.rpc('wager_create_wallet_link_session', {
          p_user_id: args.user_id,
          p_token_hash_hex: args.token_hash_hex,
          p_expires_at: args.expires_at,
        }),
      );
      return parseWalletLinkSessionResult(payload);
    },

    async verifyWalletLink(args) {
      const payload = unwrapRows<unknown>(
        'wager_verify_wallet_link',
        await client.rpc('wager_verify_wallet_link', {
          p_challenge_id: args.challenge_id,
          p_user_id: args.user_id,
          p_pubkey: args.pubkey,
          p_challenge_hash_hex: args.challenge_hash_hex,
        }),
      );
      return parseWalletLinkResult(payload);
    },

    async createPendingStakeIntent(args) {
      const payload = unwrapRows<unknown>(
        'wager_create_pending_stake_intent',
        await client.rpc('wager_create_pending_stake_intent', {
          p_user_id: args.user_id,
          p_group_id: args.group_id,
          p_market_id: args.market_id,
          p_side: args.side,
          p_lamports: lamportsToDb('createPendingStakeIntent.lamports', args.lamports),
          p_intent_key_hash_hex: args.intent_key_hash_hex,
          p_expires_at: args.expires_at,
        }),
      );
      return parseCreateIntentResult(payload);
    },

    async resolveActiveStakeIntent(userId) {
      const payload = unwrapRows<unknown>(
        'wager_resolve_active_stake_intent',
        await client.rpc('wager_resolve_active_stake_intent', { p_user_id: userId }),
      );
      return parseResolveIntentResult(payload);
    },

    async markStakeIntentFunded(userId, intentId) {
      return mutateIntent(client, 'wager_mark_stake_intent_funded', userId, intentId);
    },

    async consumeReadyStakeIntent(userId, intentId) {
      const payload = unwrapRows<unknown>(
        'wager_consume_ready_stake_intent',
        await client.rpc('wager_consume_ready_stake_intent', {
          p_user_id: userId,
          p_intent_id: intentId,
        }),
      );
      return parseResolveIntentResult(payload);
    },

    async cancelStakeIntent(userId, intentId) {
      return mutateIntent(client, 'wager_cancel_stake_intent', userId, intentId);
    },
  };
}

function parseWalletLinkSessionResult(payload: unknown): WalletLinkSessionResult {
  const row = record('wager_create_wallet_link_session', payload);
  if (row.ok === true && typeof row.session_id === 'string' && isUuid(row.session_id)) {
    return { ok: true, session_id: row.session_id };
  }
  if (row.ok === false && (row.code === 'session_invalid' || row.code === 'user_not_found')) {
    return { ok: false, code: row.code };
  }
  throw new DbError('wager_create_wallet_link_session', {
    message: `malformed RPC payload: ${JSON.stringify(payload)}`,
  });
}

async function mutateIntent(
  client: WagerDbClient,
  fn: 'wager_mark_stake_intent_funded' | 'wager_cancel_stake_intent',
  userId: number,
  intentId: string,
): Promise<MutatePendingStakeIntentResult> {
  const payload = unwrapRows<unknown>(fn, await client.rpc(fn, { p_user_id: userId, p_intent_id: intentId }));
  const row = record(fn, payload);
  if (row.ok === true) return { ok: true };
  if (row.ok === false && isIntentCode(row.code)) {
    return { ok: false, code: row.code };
  }
  throw new DbError(fn, { message: `malformed RPC payload: ${JSON.stringify(payload)}` });
}

function parseWalletLinkResult(payload: unknown): VerifiedWalletLinkResult {
  const row = record('wager_verify_wallet_link', payload);
  if (row.ok === false && isWalletLinkCode(row.code)) {
    return { ok: false, code: row.code };
  }
  if (row.ok === true && typeof row.relinked === 'boolean' && typeof row.link_id === 'number' && Number.isSafeInteger(row.link_id)) {
    return { ok: true, relinked: row.relinked, link_id: row.link_id };
  }
  throw new DbError('wager_verify_wallet_link', { message: `malformed RPC payload: ${JSON.stringify(payload)}` });
}

function parseCreateIntentResult(payload: unknown): CreatePendingStakeIntentResult {
  const row = record('wager_create_pending_stake_intent', payload);
  if (row.ok === false && isIntentCode(row.code)) {
    const result: CreatePendingStakeIntentResult = { ok: false, code: row.code };
    return typeof row.intent_id === 'string' ? { ...result, intent_id: row.intent_id } : result;
  }
  if (row.ok === true && isUuid(row.intent_id) && isIntentState(row.state)) {
    return { ok: true, intent_id: row.intent_id, state: row.state };
  }
  throw new DbError('wager_create_pending_stake_intent', { message: `malformed RPC payload: ${JSON.stringify(payload)}` });
}

function parseResolveIntentResult(payload: unknown): ResolvePendingStakeIntentResult {
  const row = record('wager_resolve_active_stake_intent', payload);
  if (row.ok === false && isIntentCode(row.code)) {
    return { ok: false, code: row.code };
  }
  if (row.ok === true) {
    const raw = parsePendingStakeIntentRow('wager_resolve_active_stake_intent', row.intent);
    return { ok: true, intent: { ...raw, lamports: lamportsFromDb('pendingIntent.lamports', raw.lamports) } };
  }
  throw new DbError('wager_resolve_active_stake_intent', { message: `malformed RPC payload: ${JSON.stringify(payload)}` });
}

function record(op: string, value: unknown): Readonly<Record<string, unknown>> {
  if (isRecord(value)) {
    return value;
  }
  throw new DbError(op, { message: `malformed RPC payload: ${JSON.stringify(value)}` });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWalletLinkCode(value: unknown): value is VerifiedWalletLinkErrorCode {
  return WALLET_LINK_CODES.has(value);
}

function isIntentCode(value: unknown): value is PendingStakeIntentErrorCode {
  return INTENT_CODES.has(value);
}

function isIntentState(value: unknown): value is PendingStakeIntentState {
  return INTENT_STATES.has(value);
}
