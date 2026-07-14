import type {
  EscrowDb,
  EscrowRelayerJobRow,
  EscrowRelayerMutationResult,
} from '@calledit/db';
import { VersionedTransaction } from '@solana/web3.js';
import {
  placementRelayPayload,
  verifyPlacementRelayTransaction,
} from './placement-relay.js';

export type EscrowRelaySignatureState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'confirmed'; readonly slot: bigint }
  | { readonly kind: 'finalized'; readonly slot: bigint }
  | { readonly kind: 'failed'; readonly errorCode: string };

export interface EscrowRelayChain {
  broadcast(rawTransactionBase64: string): Promise<string>;
  signatureState(signature: string): Promise<EscrowRelaySignatureState>;
  genesisHash(): Promise<string>;
  blockHeight(): Promise<bigint>;
  isBlockhashValid(blockhash: string): Promise<boolean>;
}

export interface EscrowRelayerPreparedTransaction {
  readonly rawTransactionBase64: string;
  readonly expectedSignature: string;
  readonly transactionMessageHashHex: string;
  readonly lastValidBlockHeight: bigint;
}

export interface EscrowRelayerTransactionBuilder {
  build(job: EscrowRelayerJobRow): Promise<EscrowRelayerPreparedTransaction>;
}

export type EscrowRelayerRunResult =
  | { readonly kind: 'submitted'; readonly jobId: string; readonly signature: string }
  | { readonly kind: 'retrying'; readonly jobId: string; readonly signature: string }
  | { readonly kind: 'complete'; readonly jobId: string; readonly signature: string }
  | { readonly kind: 'terminal'; readonly jobId: string; readonly errorCode: string };

export class EscrowRelayerWorkerError extends Error {
  readonly name = 'EscrowRelayerWorkerError';

  constructor(readonly code: 'invalid_job' | 'transition_rejected' | 'builder_unavailable') {
    super(`escrow relayer worker failed: ${code}`);
  }
}

function lease(job: EscrowRelayerJobRow): { readonly workerId: string; readonly leaseToken: string } {
  if (job.custodyMode !== 'escrow' || job.leaseOwner === null || job.leaseToken === null) {
    throw new EscrowRelayerWorkerError('invalid_job');
  }
  return { workerId: job.leaseOwner, leaseToken: job.leaseToken };
}

function requireMutation(result: EscrowRelayerMutationResult): void {
  if (!result.ok) throw new EscrowRelayerWorkerError('transition_rejected');
}

function recentBlockhash(rawTransactionBase64: string): string {
  try {
    return VersionedTransaction.deserialize(
      Buffer.from(rawTransactionBase64, 'base64'),
    ).message.recentBlockhash;
  } catch (error) {
    if (error instanceof Error) throw new EscrowRelayerWorkerError('invalid_job');
    throw error;
  }
}

function unixTimestamp(iso: string): bigint {
  const milliseconds = Date.parse(iso);
  if (!Number.isFinite(milliseconds)) throw new EscrowRelayerWorkerError('invalid_job');
  return BigInt(Math.floor(milliseconds / 1_000));
}

export function createEscrowRelayerWorker(options: {
  readonly db: Pick<
    EscrowDb,
    'leaseRelayerJobs' | 'recordRelayerSignedTransaction' | 'markRelayerSubmitted' |
    'retryRelayerJob' | 'completeRelayerJob' | 'deadLetterRelayerJob'
  >;
  readonly chain: EscrowRelayChain;
  readonly workerId: string;
  readonly retryAt: (nowIso: string) => string;
  readonly builders?: Partial<Record<EscrowRelayerJobRow['kind'], EscrowRelayerTransactionBuilder>>;
}): { runOnce(nowIso: string, limit: number): Promise<readonly EscrowRelayerRunResult[]> } {
  async function retryUnknown(job: EscrowRelayerJobRow, errorCode: string, nowIso: string): Promise<void> {
    requireMutation(await options.db.retryRelayerJob({
      jobId: job.id,
      ...lease(job),
      errorCode,
      retryAtIso: options.retryAt(nowIso),
      confirmationUnknown: true,
      nowIso,
    }));
  }

  async function dead(job: EscrowRelayerJobRow, errorCode: string, nowIso: string): Promise<EscrowRelayerRunResult> {
    requireMutation(await options.db.deadLetterRelayerJob({
      jobId: job.id, ...lease(job), errorCode, nowIso,
    }));
    return { kind: 'terminal', jobId: job.id, errorCode };
  }

  async function processPersisted(job: EscrowRelayerJobRow, nowIso: string): Promise<EscrowRelayerRunResult> {
    const raw = job.rawTransactionBase64;
    const signature = job.expectedSignature;
    if (raw === null || signature === null || job.lastValidBlockHeight === null) {
      throw new EscrowRelayerWorkerError('invalid_job');
    }
    const state = await options.chain.signatureState(signature);
    if (state.kind === 'finalized') {
      requireMutation(await options.db.completeRelayerJob({ jobId: job.id, ...lease(job), nowIso }));
      return { kind: 'complete', jobId: job.id, signature };
    }
    if (state.kind === 'failed') return dead(job, state.errorCode, nowIso);
    if (state.kind === 'confirmed') {
      await retryUnknown(job, 'awaiting_finality', nowIso);
      return { kind: 'retrying', jobId: job.id, signature };
    }
    const blockhash = recentBlockhash(raw);
    if (await options.chain.isBlockhashValid(blockhash)) {
      const payload = placementRelayPayload(job);
      if (payload !== null) {
        if (payload.rawTransactionBase64 !== raw || payload.expectedSignature !== signature) {
          return dead(job, 'signed_payload_mismatch', nowIso);
        }
        try {
          await verifyPlacementRelayTransaction({
            job, payload, chain: options.chain, nowUnix: unixTimestamp(nowIso),
          });
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          return dead(job, 'user_signature_invalid_or_expired', nowIso);
        }
      }
      try {
        const observed = await options.chain.broadcast(raw);
        if (observed !== signature) return dead(job, 'signature_mismatch', nowIso);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
      }
      await retryUnknown(job, 'confirmation_unknown', nowIso);
      return { kind: 'retrying', jobId: job.id, signature };
    }
    const currentBlockHeight = await options.chain.blockHeight();
    if (placementRelayPayload(job) !== null) return dead(job, 'user_signature_expired', nowIso);
    if (currentBlockHeight <= job.lastValidBlockHeight) {
      await retryUnknown(job, 'blockhash_validity_uncertain', nowIso);
      return { kind: 'retrying', jobId: job.id, signature };
    }
    requireMutation(await options.db.retryRelayerJob({
      jobId: job.id,
      ...lease(job),
      errorCode: 'expired_not_landed',
      retryAtIso: options.retryAt(nowIso),
      confirmationUnknown: false,
      fullHistoryCheckedAtIso: nowIso,
      currentBlockHeight,
      nowIso,
    }));
    return { kind: 'retrying', jobId: job.id, signature };
  }

  async function process(job: EscrowRelayerJobRow, nowIso: string): Promise<EscrowRelayerRunResult> {
    if (job.rawTransactionBase64 !== null) return processPersisted(job, nowIso);
    const payload = placementRelayPayload(job);
    const builder = options.builders?.[job.kind];
    if (payload === null && builder === undefined) return dead(job, 'builder_unavailable', nowIso);
    let prepared: EscrowRelayerPreparedTransaction;
    if (payload !== null) {
      try {
        prepared = await verifyPlacementRelayTransaction({
          job, payload, chain: options.chain, nowUnix: unixTimestamp(nowIso),
        });
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return dead(job, 'invalid_user_transaction', nowIso);
      }
    } else if (builder !== undefined) {
      prepared = await builder.build(job);
    } else {
      return dead(job, 'builder_unavailable', nowIso);
    }
    requireMutation(await options.db.recordRelayerSignedTransaction({
      jobId: job.id,
      ...lease(job),
      ...prepared,
      nowIso,
    }));
    try {
      const observed = await options.chain.broadcast(prepared.rawTransactionBase64);
      if (observed !== prepared.expectedSignature) return dead(job, 'signature_mismatch', nowIso);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      await retryUnknown(job, 'broadcast_unknown', nowIso);
      return { kind: 'retrying', jobId: job.id, signature: prepared.expectedSignature };
    }
    requireMutation(await options.db.markRelayerSubmitted({
      jobId: job.id, ...lease(job), expectedSignature: prepared.expectedSignature, nowIso,
    }));
    return { kind: 'submitted', jobId: job.id, signature: prepared.expectedSignature };
  }

  return {
    async runOnce(nowIso, limit) {
      const jobs = await options.db.leaseRelayerJobs({ workerId: options.workerId, nowIso, limit });
      return Promise.all(jobs.map((job) => process(job, nowIso)));
    },
  };
}
