import type { EscrowRelayerJobRow } from '@calledit/db';
import {
  deriveMarketPda,
  hexToBytes,
  verifySponsoredPositionTransaction,
} from '@calledit/escrow-sdk';
import { VersionedTransaction } from '@solana/web3.js';
import { z } from 'zod';
import { PLACEMENT_RELAYER_STORAGE_KIND } from './placement-types.js';
import { inspectUserSignedTransaction } from './transaction-signatures.js';

const payloadSchema = z.object({
  operation: z.literal('place_position'),
  rawTransactionBase64: z.string().min(1), expectedSignature: z.string().min(1),
  transactionMessageHashHex: z.string().regex(/^[0-9a-fA-F]{64}$/),
  recentBlockhash: z.string().min(1), lastValidBlockHeight: z.string().regex(/^\d+$/),
  feePayer: z.string().min(1), ownerPubkey: z.string().min(1), programId: z.string().min(1),
  canonicalUsdcMint: z.string().min(1), marketId: z.string().uuid(), marketPda: z.string().min(1),
  marketDocumentHashHex: z.string().regex(/^[0-9a-fA-F]{64}$/),
  side: z.enum(['back', 'doubt']), asset: z.enum(['sol', 'usdc']),
  amountAtomic: z.string().regex(/^\d+$/), expectedRatioMilli: z.number().int().positive(),
  eventEpoch: z.string().regex(/^\d+$/), lotNonce: z.string().regex(/^\d+$/),
  expiresAt: z.string().regex(/^\d+$/), genesisHash: z.string().min(1),
}).passthrough();

export type EscrowPlacementRelayPayload = z.infer<typeof payloadSchema>;

export interface EscrowPlacementRelayChain {
  genesisHash(): Promise<string>;
  blockHeight(): Promise<bigint>;
}

export interface EscrowVerifiedPlacementTransaction {
  readonly rawTransactionBase64: string;
  readonly expectedSignature: string;
  readonly transactionMessageHashHex: string;
  readonly lastValidBlockHeight: bigint;
}

export function placementRelayPayload(job: EscrowRelayerJobRow): EscrowPlacementRelayPayload | null {
  if (job.kind !== PLACEMENT_RELAYER_STORAGE_KIND) return null;
  const result = payloadSchema.safeParse(job.payload);
  return result.success ? result.data : null;
}

export async function verifyPlacementRelayTransaction(input: {
  readonly job: EscrowRelayerJobRow;
  readonly payload: EscrowPlacementRelayPayload;
  readonly chain: EscrowPlacementRelayChain;
  readonly nowUnix: bigint;
}): Promise<EscrowVerifiedPlacementTransaction> {
  const { job, payload } = input;
  if (
    job.programId !== payload.programId || job.marketId !== payload.marketId ||
    job.ownerPubkey !== payload.ownerPubkey ||
    deriveMarketPda(payload.programId, payload.marketId).address !== payload.marketPda
  ) throw new TypeError('placement relay identity mismatch');
  const verified = inspectUserSignedTransaction({
    rawTransactionBase64: payload.rawTransactionBase64,
    expectedMessageHashHex: payload.transactionMessageHashHex,
    feePayer: payload.feePayer,
    owner: payload.ownerPubkey,
  });
  if (
    verified.expectedSignature !== payload.expectedSignature ||
    verified.recentBlockhash !== payload.recentBlockhash
  ) throw new TypeError('placement relay signed identity mismatch');
  const transaction = VersionedTransaction.deserialize(Buffer.from(payload.rawTransactionBase64, 'base64'));
  const [currentBlockHeight, observedGenesisHash] = await Promise.all([
    input.chain.blockHeight(),
    input.chain.genesisHash(),
  ]);
  await verifySponsoredPositionTransaction(transaction, {
    programId: payload.programId, relayerFeePayer: payload.feePayer, userWallet: payload.ownerPubkey,
    canonicalUsdcMint: payload.canonicalUsdcMint, marketUuid: payload.marketId,
    marketDocumentHash: hexToBytes(payload.marketDocumentHashHex), side: payload.side,
    amount: BigInt(payload.amountAtomic), asset: payload.asset,
    expectedRatioMilli: payload.expectedRatioMilli, expectedEventEpoch: BigInt(payload.eventEpoch),
    expectedLotNonce: BigInt(payload.lotNonce), expiresAt: BigInt(payload.expiresAt),
    expectedGenesisHash: payload.genesisHash, observedGenesisHash,
    recentBlockhash: payload.recentBlockhash, lastValidBlockHeight: BigInt(payload.lastValidBlockHeight),
    currentBlockHeight, currentUnixTimestamp: input.nowUnix, requireRelayerSignature: true,
  });
  return {
    rawTransactionBase64: verified.rawTransactionBase64,
    expectedSignature: verified.expectedSignature,
    transactionMessageHashHex: verified.messageHashHex,
    lastValidBlockHeight: BigInt(payload.lastValidBlockHeight),
  };
}
