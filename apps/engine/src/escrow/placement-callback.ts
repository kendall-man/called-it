import {
  hexToBytes,
  verifySponsoredPositionTransaction,
} from '@calledit/escrow-sdk';
import { VersionedTransaction } from '@solana/web3.js';
import { inspectUserSignedTransaction } from './transaction-signatures.js';
import { hashPlacementToken, restorePlacementAuthorization } from './placement-presentation.js';
import {
  EscrowPlacementError,
  type AcceptEscrowPlacementInput,
  type AcceptEscrowPlacementResult,
  type EscrowPlacementAuthorization,
  type EscrowPlacementDatabase,
  type EscrowPlacementServiceDependencies,
} from './placement-types.js';

function placementIdempotencyKey(programId: string, signature: string): string {
  return `escrow:v1:position_placement:${programId.length}.${programId}:${signature.length}.${signature}`;
}

function transactionFromBase64(value: string): VersionedTransaction {
  try {
    return VersionedTransaction.deserialize(Buffer.from(value, 'base64'));
  } catch (error) {
    if (error instanceof Error) throw new EscrowPlacementError('invalid_signed_transaction');
    throw error;
  }
}

export function createPlacementCallbackAcceptor(
  db: Pick<EscrowPlacementDatabase,
    'getSigningSession' | 'consumeSigningSessionAndEnqueuePlacement'>,
  dependencies: EscrowPlacementServiceDependencies,
): (input: AcceptEscrowPlacementInput) => Promise<AcceptEscrowPlacementResult> {
  return async (input) => {
    const tokenHashHex = hashPlacementToken(input.token);
    const stored = await db.getSigningSession({ tokenHashHex, nowIso: dependencies.clock().iso });
    if (!stored.ok) return { kind: 'rejected', code: stored.code };
    let authorization: EscrowPlacementAuthorization;
    try {
      authorization = restorePlacementAuthorization(stored.authorization);
    } catch (error) {
      if (error instanceof Error) throw new EscrowPlacementError('invalid_signed_transaction');
      throw error;
    }
    if (
      authorization.marketUuid !== input.marketId ||
      authorization.programId !== dependencies.deployment.programId ||
      authorization.relayerFeePayer !== dependencies.sponsor.publicKey.toBase58() ||
      authorization.canonicalUsdcMint !== dependencies.deployment.canonicalUsdcMint ||
      authorization.genesisHash !== dependencies.deployment.genesisHash
    ) {
      throw new EscrowPlacementError('invalid_signed_transaction');
    }
    const transaction = transactionFromBase64(input.rawTransactionBase64);
    const now = dependencies.clock();
    const currentBlockHeight = await dependencies.chain.blockHeight();
    const observedGenesisHash = await dependencies.chain.genesisHash();
    if (!await dependencies.chain.isBlockhashValid(authorization.recentBlockhash)) {
      throw new EscrowPlacementError('blockhash_invalid');
    }
    await verifySponsoredPositionTransaction(transaction, {
      programId: authorization.programId,
      relayerFeePayer: authorization.relayerFeePayer,
      userWallet: input.ownerPubkey,
      canonicalUsdcMint: authorization.canonicalUsdcMint,
      marketUuid: authorization.marketUuid,
      marketDocumentHash: hexToBytes(authorization.marketDocumentHashHex),
      side: authorization.side,
      amount: authorization.amount,
      asset: authorization.asset,
      expectedRatioMilli: authorization.expectedRatioMilli,
      expectedEventEpoch: authorization.expectedEventEpoch,
      expectedLotNonce: authorization.expectedLotNonce,
      expiresAt: authorization.expiresAt,
      expectedGenesisHash: dependencies.deployment.genesisHash,
      observedGenesisHash,
      recentBlockhash: authorization.recentBlockhash,
      lastValidBlockHeight: authorization.lastValidBlockHeight,
      currentBlockHeight,
      currentUnixTimestamp: now.unix,
      requireRelayerSignature: true,
    });
    const verified = inspectUserSignedTransaction({
      rawTransactionBase64: input.rawTransactionBase64,
      expectedMessageHashHex: authorization.messageHashHex,
      feePayer: authorization.relayerFeePayer,
      owner: input.ownerPubkey,
    });
    const readiness = await dependencies.readiness();
    if (readiness.status === 'not_ready') {
      throw new EscrowPlacementError('market_unavailable');
    }
    const enqueue = db.consumeSigningSessionAndEnqueuePlacement;
    if (enqueue === undefined) {
      throw new EscrowPlacementError('durable_enqueue_rejected');
    }
    const result = await enqueue({
      tokenHashHex,
      userId: input.telegramUserId,
      providerUserId: input.privyUserId,
      providerWalletId: input.privyWalletId,
      ownerPubkey: input.ownerPubkey,
      marketId: input.marketId,
      transactionMessageHashHex: verified.messageHashHex,
      transactionSignature: verified.expectedSignature,
      idempotencyKey: placementIdempotencyKey(authorization.programId, verified.expectedSignature),
      cluster: dependencies.deployment.cluster,
      programId: dependencies.deployment.programId,
      custodyMode: 'escrow',
      custodyVersion: dependencies.deployment.custodyVersion,
      payload: {
        operation: 'place_position',
        rawTransactionBase64: verified.rawTransactionBase64,
        expectedSignature: verified.expectedSignature,
        transactionMessageHashHex: verified.messageHashHex,
        recentBlockhash: verified.recentBlockhash,
        lastValidBlockHeight: String(authorization.lastValidBlockHeight),
        marketId: input.marketId,
        marketPda: authorization.marketPda,
        feePayer: authorization.relayerFeePayer,
        ownerPubkey: input.ownerPubkey,
        programId: authorization.programId,
        canonicalUsdcMint: authorization.canonicalUsdcMint,
        marketDocumentHashHex: authorization.marketDocumentHashHex,
        expectedRatioMilli: authorization.expectedRatioMilli,
        genesisHash: authorization.genesisHash,
        side: authorization.side,
        asset: authorization.asset,
        amountAtomic: String(authorization.amount),
        lotNonce: String(authorization.expectedLotNonce),
        eventEpoch: String(authorization.expectedEventEpoch),
        expiresAt: String(authorization.expiresAt),
      },
      dueAtIso: now.iso,
      maxAttempts: 8,
      nowIso: now.iso,
    });
    if (!result.ok) return { kind: 'rejected', code: result.code };
    return {
      kind: 'accepted',
      duplicate: result.duplicate,
      jobCreated: result.jobCreated,
      signature: verified.expectedSignature,
    };
  };
}
