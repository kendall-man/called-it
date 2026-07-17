import { Transaction, type Connection } from '@solana/web3.js';
import { base58Encode } from './codecs.js';
import {
  broadcastRawTx,
  getSigStatus,
  isBlockheightExceeded,
  type BlockHeightRpc,
  type BroadcastRpc,
  type SigStatusKnown,
  type SigStatusRpc,
} from './transfer.js';
import { buildValidateStatInstruction, type SubmitValidateStatParams } from './txoracle.js';

export interface PreparedProofSubmission {
  readonly signature: string;
  readonly rawTxB64: string;
  readonly lastValidBlockHeight: number;
}

export type BuildProofSubmissionResult =
  | { readonly ok: true; readonly submission: PreparedProofSubmission }
  | { readonly ok: false; readonly error: string };

export type BroadcastProofSubmissionResult =
  | { readonly ok: true; readonly alreadyProcessed: boolean }
  | { readonly ok: false; readonly error: string };

export type ProofSubmissionRecoveryPlan =
  | { readonly kind: 'landed' }
  | { readonly kind: 'onchain_failed'; readonly error: string }
  | { readonly kind: 'wait' }
  | { readonly kind: 'rebroadcast' }
  | { readonly kind: 'rebuild' };

export type InspectProofSubmissionResult =
  | { readonly ok: true; readonly plan: ProofSubmissionRecoveryPlan }
  | { readonly ok: false; readonly error: string };

/**
 * Signs validate_stat bytes locally. The returned signature is final before
 * broadcast and therefore must be persisted with the raw transaction first.
 */
export async function buildSignedValidateStatSubmission(
  params: SubmitValidateStatParams,
): Promise<BuildProofSubmissionResult> {
  try {
    const latest = await params.connection.getLatestBlockhash('finalized');
    if (!Number.isSafeInteger(latest.lastValidBlockHeight) || latest.lastValidBlockHeight <= 0) {
      return { ok: false, error: 'invalid last valid block height' };
    }
    const instruction = await buildValidateStatInstruction(params);
    const transaction = new Transaction({
      feePayer: params.wallet.publicKey,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    }).add(instruction);
    transaction.sign(params.wallet);
    if (transaction.signature === null) {
      return { ok: false, error: 'validate_stat signing produced no signature' };
    }
    return {
      ok: true,
      submission: {
        signature: base58Encode(transaction.signature),
        rawTxB64: transaction.serialize().toString('base64'),
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
    };
  } catch (error) {
    return { ok: false, error: `build validate_stat: ${errorMessage(error)}` };
  }
}

/** Rebroadcasts the exact persisted bytes and rejects a node-returned mismatched signature. */
export async function rebroadcastProofSubmission(
  rpc: BroadcastRpc,
  submission: PreparedProofSubmission,
): Promise<BroadcastProofSubmissionResult> {
  const result = await broadcastRawTx(rpc, submission.rawTxB64);
  if (!result.ok) return result;
  if (result.sig !== submission.signature) {
    return { ok: false, error: 'broadcast signature did not match persisted transaction' };
  }
  return { ok: true, alreadyProcessed: result.alreadyProcessed };
}

/**
 * Full-history status plus finalized expiry is the only safe source for a
 * re-sign decision. Any uncertainty leaves the existing bytes in place.
 */
export async function inspectProofSubmission(
  rpc: SigStatusRpc & BlockHeightRpc,
  submission: PreparedProofSubmission,
): Promise<InspectProofSubmissionResult> {
  const status = await getSigStatus(rpc, submission.signature);
  if (!status.ok) return { ok: false, error: status.error };
  if (status.found) return { ok: true, plan: planProofSubmissionRecovery(status, false) };

  const expiry = await isBlockheightExceeded(rpc, submission.lastValidBlockHeight);
  if (!expiry.ok) return { ok: false, error: expiry.error };
  return { ok: true, plan: planProofSubmissionRecovery(status, expiry.exceeded) };
}

export function planProofSubmissionRecovery(
  status: SigStatusKnown,
  blockheightExceeded: boolean,
): ProofSubmissionRecoveryPlan {
  if (status.found) {
    if (status.err !== null) return { kind: 'onchain_failed', error: status.err };
    if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
      return { kind: 'landed' };
    }
    return { kind: 'wait' };
  }
  return blockheightExceeded ? { kind: 'rebuild' } : { kind: 'rebroadcast' };
}

type Satisfies<T extends U, U> = T;
type _ConnectionStatus = Satisfies<Connection, SigStatusRpc>;
type _ConnectionHeight = Satisfies<Connection, BlockHeightRpc>;
type _ConnectionBroadcast = Satisfies<Connection, BroadcastRpc>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'non_error_throw';
}
