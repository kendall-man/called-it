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
  /** Optional public receipt page URL. Private signing tokens are rejected. */
  readonly receiptUrl?: string;
  /** Optional public recovery route. Private signing tokens are rejected. */
  readonly recoveryUrl?: string;
}

/**
 * Explicit parent integration hook for finalized escrow projections. Telegram
 * handlers cannot observe finalizer events directly, so the finalized-indexer
 * bridge must call this after it resolves the signer Telegram user id.
 * Both texts state facts, so an at-least-once redelivery reads fine twice.
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
  const receiptUrl = publicEscrowActionUrl(input.receiptUrl);
  const recoveryUrl = publicEscrowActionUrl(input.recoveryUrl);
  const text = input.state === 'finalized'
    ? [
        prefix,
        'Your position is finalized on-chain. The group card refreshes from finalized chain data.',
        ...(receiptUrl === null ? [] : [`Receipt: ${receiptUrl}`]),
      ].join('\n')
    : [
        prefix,
        `That position was rolled back on-chain and will not count. Your ${input.asset.toUpperCase()} is not lost — it comes back through the escrow refund.`,
        'Open /wallet in private chat to track the refund.',
      ].join('\n');
  await outbox.enqueue({
    idempotencyKey: input.idempotencyKey,
    telegramUserId: input.telegramUserId,
    text,
    ...(recoveryUrl === null ? {} : { recoveryUrl }),
  });
}

/** Caps the in-memory completion-DM dedupe set so it cannot grow unbounded. */
const COMPLETION_DM_DEDUPE_LIMIT = 4_096;

/**
 * Per-process completion-DM outbox. Idempotency is the event key: a redelivered
 * projection (indexer replay, restart) sends at most one DM per process, and
 * the copy stays safe to receive twice across restarts. Delivery failures
 * (user never started the bot) are swallowed and logged by the send queue,
 * exactly like the custodial deposit DMs.
 */
export function createEscrowSignerCompletionDmOutbox(options: {
  readonly post: (chatId: number, text: string) => void;
}): EscrowSignerCompletionDmOutbox {
  const delivered = new Set<string>();
  return {
    async enqueue(input) {
      if (delivered.has(input.idempotencyKey)) return;
      if (delivered.size >= COMPLETION_DM_DEDUPE_LIMIT) {
        const oldest = delivered.values().next().value;
        if (oldest !== undefined) delivered.delete(oldest);
      }
      delivered.add(input.idempotencyKey);
      options.post(
        input.telegramUserId,
        input.recoveryUrl === undefined ? input.text : `${input.text}\n${input.recoveryUrl}`,
      );
    },
  };
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

/**
 * Sent to a signer whose approved placement dead-lettered before landing
 * (blockhash died pre-broadcast). The relayer never re-signs user
 * transactions, so a fresh tap is the only recovery.
 */
export function escrowApprovalLapsedDmText(): string {
  return 'That approval lapsed before it reached the chain. No SOL moved. Tap your choice on the card again for a fresh approval.';
}

/** Dead-letter codes the affected signer can act on by simply re-tapping. */
export const ESCROW_USER_ATTRIBUTABLE_DEAD_LETTERS: readonly string[] = [
  'user_signature_expired',
  'user_signature_invalid_or_expired',
];

/** Ops chat line for a dead-lettered relayer job (internal surface, code included). */
export function escrowOpsDeadLetterAlertText(errorCode: string): string {
  return [
    `ESCROW OPS — a relayer job dead-lettered (code: ${errorCode}).`,
    'No SOL is lost; escrowed funds stay recoverable from durable state.',
    'Check the engine logs for the affected jobs.',
  ].join('\n');
}

/** Ops chat line for a degraded escrow runtime signal (internal surface). */
export function escrowOpsRuntimeAlertText(reason: string): string {
  switch (reason) {
    case 'oracle_threshold_unavailable':
      return 'ESCROW OPS — oracle attestation quorum is unavailable. Settlement work waits until enough oracle signers respond. Check the oracle signer endpoints.';
    case 'indexer_lagging':
    case 'indexer_unavailable':
      return 'ESCROW OPS — the finalized indexer is behind the chain. Cards and receipts update late until it catches up. Check RPC health and the indexer cursor.';
    case 'rpc_unavailable':
      return 'ESCROW OPS — the Solana RPC connection is failing. Escrow work pauses until it recovers. Check the RPC endpoint.';
    default:
      return `ESCROW OPS — escrow runtime degraded (reason: ${reason}). Check the engine logs.`;
  }
}

/** Readiness reasons worth an ops page (the rest fail loudly at boot). */
export const ESCROW_OPS_ALERT_READINESS_REASONS: readonly string[] = [
  'oracle_threshold_unavailable',
  'indexer_lagging',
  'indexer_unavailable',
  'rpc_unavailable',
];

export const ESCROW_OPS_ALERT_WINDOW_MS = 10 * 60_000;

/** Structural twin of the relayer worker's per-job run result. */
export type EscrowRelayerObservedResult =
  | {
      readonly kind: 'submitted' | 'retrying' | 'complete';
      readonly jobId: string;
      readonly signature: string;
    }
  | { readonly kind: 'terminal'; readonly jobId: string; readonly errorCode: string };

export interface EscrowProgressObserver {
  /** Sees every relayer cycle's results; presentation only, never throws. */
  observeRelayerResults(results: readonly EscrowRelayerObservedResult[]): void;
  /** Feeds periodic escrow readiness reports into the same ops alert stream. */
  observeEscrowReadiness(report: {
    readonly status: 'ready' | 'not_ready';
    readonly reasons: readonly string[];
  }): void;
}

/**
 * Maps discarded runtime signals to humans: terminal placement failures the
 * signer caused become a private "tap again" DM, and every dead letter plus
 * degraded-runtime reason becomes a rate-limited ops chat alert (at most one
 * message per error code per window, in-memory).
 */
export function createEscrowProgressObserver(options: {
  readonly opsChatId: number | null;
  readonly post: (chatId: number, text: string) => void;
  /** Joins a dead-lettered job to its signer; null when the join is unavailable. */
  readonly resolveDeadLetterSigner: (jobId: string) => Promise<{
    readonly kind: string;
    readonly telegramUserId: number | null;
  } | null>;
  readonly now: () => number;
  readonly log: {
    info(event: string, fields?: Readonly<Record<string, unknown>>): void;
    warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
  };
  readonly alertWindowMs?: number;
}): EscrowProgressObserver {
  const windowMs = options.alertWindowMs ?? ESCROW_OPS_ALERT_WINDOW_MS;
  const lastAlertAtMs = new Map<string, number>();

  function opsAlert(code: string, text: string): void {
    if (options.opsChatId === null) return;
    const nowMs = options.now();
    const last = lastAlertAtMs.get(code);
    if (last !== undefined && nowMs - last < windowMs) return;
    lastAlertAtMs.set(code, nowMs);
    options.post(options.opsChatId, text);
  }

  async function dmLapsedSigner(jobId: string, errorCode: string): Promise<void> {
    let signer: Awaited<ReturnType<typeof options.resolveDeadLetterSigner>>;
    try {
      signer = await options.resolveDeadLetterSigner(jobId);
    } catch {
      signer = null;
    }
    if (signer === null || signer.kind !== 'position_placement' || signer.telegramUserId === null) {
      options.log.warn('escrow_dead_letter_signer_unresolved', { errorCode });
      return;
    }
    options.post(signer.telegramUserId, escrowApprovalLapsedDmText());
    options.log.info('escrow_dead_letter_signer_notified', { errorCode });
  }

  return {
    observeRelayerResults(results) {
      for (const result of results) {
        if (result.kind !== 'terminal') continue;
        opsAlert(result.errorCode, escrowOpsDeadLetterAlertText(result.errorCode));
        if (ESCROW_USER_ATTRIBUTABLE_DEAD_LETTERS.includes(result.errorCode)) {
          void dmLapsedSigner(result.jobId, result.errorCode);
        }
      }
    },
    observeEscrowReadiness(report) {
      if (report.status === 'ready') return;
      for (const reason of report.reasons) {
        if (!ESCROW_OPS_ALERT_READINESS_REASONS.includes(reason)) continue;
        opsAlert(reason, escrowOpsRuntimeAlertText(reason));
      }
    },
  };
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
