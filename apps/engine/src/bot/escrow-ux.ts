import type { WagerAsset } from '@calledit/market-engine';
import type { SolanaNetwork } from '../solana-network.js';
import { formatAssetAmount } from '../wager/format.js';
import { normalizeInlineText } from './message-budget.js';

export const OPAQUE_SIGNING_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type EscrowPlacementRejectionCode =
  | 'callback_expired'
  | 'market_closed'
  | 'paused'
  | 'wallet_required'
  | 'amount_out_of_range'
  | 'temporarily_unavailable';

export interface EscrowPlacementSessionInput {
  readonly idempotencyKey: string;
  readonly telegramUserId: number;
  readonly groupId: number;
  readonly marketId: string;
  readonly side: 'back' | 'doubt';
  readonly asset: WagerAsset;
  readonly amountAtomic: bigint;
  readonly network: SolanaNetwork;
  readonly replay: boolean;
}

export type EscrowPlacementSessionResult =
  | {
      readonly kind: 'created';
      readonly token: string;
      readonly expiresAt: string;
      readonly duplicate: boolean;
    }
  | { readonly kind: 'rejected'; readonly code: EscrowPlacementRejectionCode };

export type EscrowWalletSessionResult =
  | {
      readonly kind: 'created';
      readonly token: string;
      readonly expiresAt: string;
      readonly legacyRecoveryUrl?: string;
    }
  | { readonly kind: 'rejected'; readonly code: 'temporarily_unavailable' };

export interface EscrowTelegramPort {
  createPlacementSession(
    input: EscrowPlacementSessionInput,
  ): Promise<EscrowPlacementSessionResult>;
  createWalletSession(input: {
    readonly telegramUserId: number;
    readonly idempotencyKey: string;
  }): Promise<EscrowWalletSessionResult>;
}

/**
 * Parent finality wiring must persist this as a unique outbox row before
 * delivery. The same idempotency key may be enqueued repeatedly after a
 * restart, but it must result in at most one private DM.
 */
export interface EscrowSignerCompletionDmOutbox {
  enqueue(input: {
    readonly idempotencyKey: string;
    readonly telegramUserId: number;
    readonly text: string;
    readonly recoveryUrl?: string;
  }): Promise<void>;
}

/** Finalized position projection mapped to its original Telegram signer. */
export interface EscrowSignerCompletionDmInput {
  /** Stable finalized event identity, such as transaction signature plus lot nonce. */
  readonly idempotencyKey: string;
  readonly telegramUserId: number;
  readonly network: SolanaNetwork;
  readonly asset: WagerAsset;
  readonly amountAtomic: bigint;
  readonly side: 'back' | 'doubt';
  readonly state: 'finalized' | 'recoverable';
  /** Optional public recovery route. Private signing tokens are rejected. */
  readonly recoveryUrl?: string;
}

/**
 * Explicit parent integration hook for finalized escrow projections. Telegram
 * handlers cannot observe finalizer events directly, so the finalized-indexer
 * bridge must call this after it resolves the signer Telegram user id.
 */
export async function enqueueEscrowSignerCompletionDm(
  outbox: EscrowSignerCompletionDmOutbox,
  input: EscrowSignerCompletionDmInput,
): Promise<void> {
  if (input.idempotencyKey.length === 0 || !Number.isSafeInteger(input.telegramUserId) || input.telegramUserId <= 0) {
    throw new TypeError('invalid escrow signer completion notification');
  }
  const side = input.side === 'back' ? 'It happens' : 'It does not';
  const prefix = `${side} · ${formatAssetAmount(input.amountAtomic, input.asset)} · On-chain escrow · ${escrowNetworkLabel(input.network)}`;
  const recoveryUrl = publicEscrowActionUrl(input.recoveryUrl);
  const text = input.state === 'finalized'
    ? `${prefix}\nYour position is finalized on-chain. The group card refreshes from finalized chain data.`
    : `${prefix}\nRecovery is available. Open /wallet in private chat.`;
  await outbox.enqueue({
    idempotencyKey: input.idempotencyKey,
    telegramUserId: input.telegramUserId,
    text,
    ...(recoveryUrl === null ? {} : { recoveryUrl }),
  });
}

export type EscrowPlacementStatus =
  | { readonly kind: 'awaiting_signature' }
  | { readonly kind: 'confirming' }
  | { readonly kind: 'finalized'; readonly positionState: 'pending' | 'active' | 'refundable' }
  | { readonly kind: 'rejected'; readonly reason: 'expired' | 'invalid' | 'closed' }
  | { readonly kind: 'recoverable'; readonly recoveryUrl?: string };

export interface EscrowPlacementStatusInput {
  readonly participantName: string;
  readonly network: SolanaNetwork;
  readonly asset: WagerAsset;
  readonly amountAtomic: bigint;
  readonly side: 'back' | 'doubt';
  readonly state: EscrowPlacementStatus;
}

export function escrowNetworkLabel(network: SolanaNetwork): string {
  return network === 'mainnet-beta' ? 'MAINNET' : 'DEVNET';
}

export function privateEscrowUrl(
  webBaseUrl: string,
  route: 'position' | 'wallet',
  token: string,
): string | null {
  if (!OPAQUE_SIGNING_TOKEN_PATTERN.test(token)) return null;
  const url = new URL(webBaseUrl);
  const basePath = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = `${basePath}/${route}/${token}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function publicEscrowActionUrl(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
    if (url.pathname.split('/').some((part) => OPAQUE_SIGNING_TOKEN_PATTERN.test(part))) return null;
    const cluster = url.searchParams.get('cluster');
    if (url.search !== '' && (url.searchParams.size !== 1 || cluster !== 'devnet')) return null;
    if (url.hash !== '') return null;
    return url.toString();
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

export function privateEscrowRecoveryUrl(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
    if (url.hash !== '') return null;
    return url.toString();
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

export function escrowSigningPrompt(input: {
  readonly network: SolanaNetwork;
  readonly side: 'back' | 'doubt';
  readonly asset: WagerAsset;
  readonly amountAtomic: bigint;
  readonly expiresAt: string;
  readonly replay: boolean;
}): string {
  const side = input.side === 'back' ? 'It happens' : 'It does not';
  return [
    input.replay ? 'Awaiting signature · COMPLETED-MATCH REPLAY' : 'Awaiting signature',
    `On-chain escrow · ${escrowNetworkLabel(input.network)} · ${formatAssetAmount(input.amountAtomic, input.asset)}`,
    ...(input.replay
      ? [input.network === 'devnet'
          ? 'Uses devnet test assets. Replay results do not change Points.'
          : 'Uses allowlisted, capped mainnet assets. Replay results do not change Points.']
      : []),
    `${side}. Check the amount, then approve it with your Privy wallet.`,
    `This private link expires at ${input.expiresAt}. Submission is not success; the group updates only after finalization.`,
  ].join('\n');
}

export function escrowPlacementRejectionText(code: EscrowPlacementRejectionCode): string {
  switch (code) {
    case 'callback_expired':
      return 'That signing request expired. Return to the group and tap your choice again.';
    case 'market_closed':
      return 'That call is closed for new positions. No assets moved.';
    case 'paused':
      return 'New on-chain positions are temporarily paused. No assets moved. Existing claims and refunds still work.';
    case 'wallet_required':
      return 'Open /wallet in private chat first, then return to the group and tap again.';
    case 'amount_out_of_range':
      return 'That amount is not available for this call. No assets moved.';
    case 'temporarily_unavailable':
      return 'Secure signing is temporarily unavailable. No assets moved. Try the same choice again shortly.';
  }
}

export function escrowPlacementStatusText(input: EscrowPlacementStatusInput): string {
  const name = normalizeInlineText(input.participantName, 64, 'A participant');
  const amount = formatAssetAmount(input.amountAtomic, input.asset);
  const side = input.side === 'back' ? 'It happens' : 'It does not';
  const prefix = `${name} · ${side} · ${amount} · ${escrowNetworkLabel(input.network)}`;
  switch (input.state.kind) {
    case 'awaiting_signature':
      return `${prefix}\nAwaiting private wallet signature. No assets have moved.`;
    case 'confirming':
      return `${prefix}\nConfirming on-chain. This is not final yet; retrying is safe.`;
    case 'finalized':
      return `${prefix}\nFinalized on-chain · ${input.state.positionState}.`;
    case 'rejected':
      return `${prefix}\nRejected (${input.state.reason}). No new position was finalized.`;
    case 'recoverable': {
      const recoveryUrl = publicEscrowActionUrl(input.state.recoveryUrl);
      return recoveryUrl === null
        ? `${prefix}\nRecovery is available. Open /wallet in private chat.`
        : `${prefix}\nRecovery is available: ${recoveryUrl}`;
    }
  }
}
