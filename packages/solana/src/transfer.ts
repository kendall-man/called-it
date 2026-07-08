/**
 * Wager-treasury SOL transfer primitives — pure chain I/O, no DB knowledge.
 *
 * The withdrawal outbox's crash-safety rests on two properties enforced here:
 *
 * - `buildSolTransfer` signs locally and returns the signature BEFORE any
 *   broadcast. Identical bytes always carry the identical signature, so a
 *   persisted raw transaction can be rebroadcast forever without risking a
 *   second send under a new signature.
 * - `getSigStatus` always passes `searchTransactionHistory: true`. The
 *   default status cache only covers recent slots, so without it a transfer
 *   that landed minutes before a crash would read "not found" and get
 *   re-signed with a fresh blockhash — a double-send. Non-negotiable.
 *
 * All fallible entry points return the house `{ ok: ... }` result objects
 * (see txoracle.ts ValidateStatResult) instead of throwing.
 */
import {
  PublicKey,
  SystemProgram,
  Transaction,
  type Connection,
  type Keypair,
} from '@solana/web3.js';
import { base58Encode } from './codecs.js';

const LAMPORTS_U64_MAX = (1n << 64n) - 1n;

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// ── buildSolTransfer ─────────────────────────────────────────────────────────

export interface BuildSolTransferParams {
  /** Treasury keypair — always the dedicated wager wallet, never the TxL one. */
  from: Keypair;
  to: PublicKey | string;
  lamports: bigint;
  recentBlockhash: string;
  lastValidBlockHeight: number;
}

export type BuildSolTransferResult =
  | { ok: true; rawTxB64: string; sig: string }
  | { ok: false; error: string };

/**
 * Build and sign a plain SOL transfer offline. The returned `sig` is final
 * before any broadcast: persist `{ sig, rawTxB64, lastValidBlockHeight }`
 * first, broadcast second, and rebroadcasts of the same bytes stay idempotent.
 */
export function buildSolTransfer(params: BuildSolTransferParams): BuildSolTransferResult {
  const { from, lamports, recentBlockhash, lastValidBlockHeight } = params;
  if (typeof lamports !== 'bigint' || lamports <= 0n || lamports > LAMPORTS_U64_MAX) {
    return {
      ok: false,
      error: `buildSolTransfer: lamports must be a positive u64 bigint, got ${String(lamports)}`,
    };
  }
  if (!Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight <= 0) {
    return {
      ok: false,
      error: `buildSolTransfer: lastValidBlockHeight must be a positive integer, got ${String(lastValidBlockHeight)}`,
    };
  }
  try {
    const to = typeof params.to === 'string' ? new PublicKey(params.to) : params.to;
    const tx = new Transaction({
      feePayer: from.publicKey,
      blockhash: recentBlockhash,
      lastValidBlockHeight,
    });
    tx.add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports }));
    tx.sign(from);
    const signature = tx.signature;
    if (!signature) {
      return { ok: false, error: 'buildSolTransfer: signing produced no signature' };
    }
    return {
      ok: true,
      rawTxB64: tx.serialize().toString('base64'),
      sig: base58Encode(signature),
    };
  } catch (cause) {
    return { ok: false, error: `buildSolTransfer: ${errorMessage(cause)}` };
  }
}

// ── broadcastRawTx ───────────────────────────────────────────────────────────

/** The one Connection facet broadcast needs (tests substitute fakes). */
export interface BroadcastRpc {
  sendRawTransaction(
    rawTransaction: Buffer,
    options?: { skipPreflight?: boolean },
  ): Promise<string>;
}

export type BroadcastResult =
  | { ok: true; sig: string; alreadyProcessed: boolean }
  | { ok: false; error: string };

const ALREADY_PROCESSED_RE = /already (been )?processed/i;

function sigFromRawTx(rawTxB64: string): string | null {
  try {
    const signature = Transaction.from(Buffer.from(rawTxB64, 'base64')).signature;
    return signature ? base58Encode(signature) : null;
  } catch {
    return null;
  }
}

/**
 * Broadcast previously signed bytes. Preflight is skipped so rebroadcasting
 * a transaction that already landed is never rejected by simulation; an
 * explicit "already processed" answer from the node is success, not failure
 * (deterministic signature — the money moved exactly once).
 */
export async function broadcastRawTx(rpc: BroadcastRpc, rawTxB64: string): Promise<BroadcastResult> {
  try {
    const sig = await rpc.sendRawTransaction(Buffer.from(rawTxB64, 'base64'), {
      skipPreflight: true,
    });
    return { ok: true, sig, alreadyProcessed: false };
  } catch (cause) {
    const error = errorMessage(cause);
    if (ALREADY_PROCESSED_RE.test(error)) {
      const sig = sigFromRawTx(rawTxB64);
      if (sig) return { ok: true, sig, alreadyProcessed: true };
    }
    return { ok: false, error: `broadcastRawTx: ${error}` };
  }
}

// ── getSigStatus ─────────────────────────────────────────────────────────────

export interface SignatureStatusLike {
  slot: number;
  err: unknown;
  confirmations?: number | null;
  confirmationStatus?: string | null;
}

/** The one Connection facet status checks need (tests substitute fakes). */
export interface SigStatusRpc {
  getSignatureStatuses(
    signatures: string[],
    config?: { searchTransactionHistory?: boolean },
  ): Promise<{ value: (SignatureStatusLike | null)[] }>;
}

export type ConfirmationLevel = 'processed' | 'confirmed' | 'finalized';

export type SigStatusResult =
  | {
      ok: true;
      found: true;
      confirmationStatus: ConfirmationLevel;
      slot: number;
      /** JSON-stringified on-chain error, or null when the tx succeeded. */
      err: string | null;
    }
  | { ok: true; found: false }
  | { ok: false; error: string };

export type SigStatusKnown = Extract<SigStatusResult, { ok: true }>;

function toConfirmationLevel(raw: string | null | undefined): ConfirmationLevel {
  return raw === 'confirmed' || raw === 'finalized' ? raw : 'processed';
}

/**
 * Look up a signature with a FULL history search. `{ found: false }` from
 * this function genuinely means "never landed" — the precondition for the
 * outbox to consider re-signing after blockhash expiry.
 */
export async function getSigStatus(rpc: SigStatusRpc, sig: string): Promise<SigStatusResult> {
  try {
    const response = await rpc.getSignatureStatuses([sig], { searchTransactionHistory: true });
    const status = response.value[0] ?? null;
    if (status === null) return { ok: true, found: false };
    return {
      ok: true,
      found: true,
      confirmationStatus: toConfirmationLevel(status.confirmationStatus),
      slot: status.slot,
      err: status.err == null ? null : JSON.stringify(status.err),
    };
  } catch (cause) {
    return { ok: false, error: `getSigStatus: ${errorMessage(cause)}` };
  }
}

// ── isBlockheightExceeded ────────────────────────────────────────────────────

/** The one Connection facet expiry checks need (tests substitute fakes). */
export interface BlockHeightRpc {
  getBlockHeight(commitment?: 'confirmed' | 'finalized'): Promise<number>;
}

export type BlockheightExceededResult =
  | { ok: true; exceeded: boolean; blockHeight: number }
  | { ok: false; error: string };

/**
 * Whether a transaction pinned to `lastValidBlockHeight` can no longer land.
 * Defaults to 'finalized' commitment: the finalized height lags, so expiry
 * is only declared once no fork can still include the blockhash — the
 * conservative side for double-send avoidance.
 */
export async function isBlockheightExceeded(
  rpc: BlockHeightRpc,
  lastValidBlockHeight: number,
  commitment: 'confirmed' | 'finalized' = 'finalized',
): Promise<BlockheightExceededResult> {
  try {
    const blockHeight = await rpc.getBlockHeight(commitment);
    return { ok: true, exceeded: blockHeight > lastValidBlockHeight, blockHeight };
  } catch (cause) {
    return { ok: false, error: `isBlockheightExceeded: ${errorMessage(cause)}` };
  }
}

// ── resolveResubmitAction ────────────────────────────────────────────────────

export type ResubmitAction =
  | { action: 'confirmed' }
  | { action: 'failed'; err: string }
  | { action: 'wait' }
  | { action: 'rebroadcast' }
  | { action: 'resign' };

/**
 * Decision table for a 'submitted' outbox row, given a history-searched
 * status and whether the blockhash has expired at finalized commitment:
 *
 * | status.found | on-chain err | confirmation        | expired | action      |
 * |--------------|--------------|---------------------|---------|-------------|
 * | yes          | yes          | any                 | any     | failed      |
 * | yes          | no           | confirmed/finalized | any     | confirmed   |
 * | yes          | no           | processed           | any     | wait        |
 * | no           | —            | —                   | no      | rebroadcast |
 * | no           | —            | —                   | yes     | resign      |
 *
 * Re-signing is ONLY safe when the status is unknown after a full history
 * search AND the blockhash can no longer land; every other combination
 * either resolves the row or rebroadcasts the identical (same-sig) bytes.
 */
export function resolveResubmitAction(
  status: SigStatusKnown,
  blockheightExceeded: boolean,
): ResubmitAction {
  if (status.found) {
    if (status.err !== null) return { action: 'failed', err: status.err };
    if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
      return { action: 'confirmed' };
    }
    // 'processed' can still be dropped or confirmed — touch nothing this tick.
    return { action: 'wait' };
  }
  return blockheightExceeded ? { action: 'resign' } : { action: 'rebroadcast' };
}

// ── compile-time proof that a live Connection satisfies the facets ───────────

type Satisfies<T extends U, U> = T;
type _BroadcastRpcCheck = Satisfies<Connection, BroadcastRpc>;
type _SigStatusRpcCheck = Satisfies<Connection, SigStatusRpc>;
type _BlockHeightRpcCheck = Satisfies<Connection, BlockHeightRpc>;
