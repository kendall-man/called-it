import { createHash } from 'node:crypto';
import {
  hexToBytes,
  verifySponsoredPositionTransactionBeforeUserSigning,
} from '@calledit/escrow-sdk';
import { VersionedTransaction } from '@solana/web3.js';
import { z } from 'zod';
import type {
  EscrowPlacementAuthorization,
  EscrowPlacementAuthorizationPresentation,
  EscrowPlacementDatabase,
  EscrowPlacementPresentationResult,
  EscrowPlacementServiceDependencies,
} from './placement-types.js';

const authorizationSchema = z.object({
  schemaVersion: z.literal(1),
  programId: z.string().min(1), relayerFeePayer: z.string().min(1), canonicalUsdcMint: z.string().min(1),
  marketUuid: z.string().uuid(), marketPda: z.string().min(1),
  marketDocumentHashHex: z.string().regex(/^[0-9a-fA-F]{64}$/), side: z.enum(['back', 'doubt']),
  amount: z.string().regex(/^\d+$/), asset: z.enum(['sol', 'usdc']),
  expectedRatioMilli: z.string().regex(/^\d+$/), expectedEventEpoch: z.string().regex(/^\d+$/),
  expectedLotNonce: z.string().regex(/^\d+$/), expiresAt: z.string().regex(/^\d+$/),
  genesisHash: z.string().min(1), recentBlockhash: z.string().min(1),
  lastValidBlockHeight: z.string().regex(/^\d+$/), messageHashHex: z.string().regex(/^[0-9a-fA-F]{64}$/),
}).strict();

export function presentPlacementAuthorization(
  authorization: EscrowPlacementAuthorization,
): EscrowPlacementAuthorizationPresentation {
  return {
    schemaVersion: 1,
    programId: authorization.programId,
    relayerFeePayer: authorization.relayerFeePayer,
    canonicalUsdcMint: authorization.canonicalUsdcMint,
    marketUuid: authorization.marketUuid,
    marketPda: authorization.marketPda,
    marketDocumentHashHex: authorization.marketDocumentHashHex,
    side: authorization.side,
    amount: authorization.amount.toString(),
    asset: authorization.asset,
    expectedRatioMilli: authorization.expectedRatioMilli.toString(),
    expectedEventEpoch: authorization.expectedEventEpoch.toString(),
    expectedLotNonce: authorization.expectedLotNonce.toString(),
    expiresAt: authorization.expiresAt.toString(),
    genesisHash: authorization.genesisHash,
    recentBlockhash: authorization.recentBlockhash,
    lastValidBlockHeight: authorization.lastValidBlockHeight.toString(),
    messageHashHex: authorization.messageHashHex,
  };
}

export function restorePlacementAuthorization(value: EscrowPlacementAuthorizationPresentation): EscrowPlacementAuthorization {
  const result = authorizationSchema.safeParse(value);
  if (!result.success) throw new TypeError('invalid durable placement authorization');
  const ratio = Number(result.data.expectedRatioMilli);
  if (!Number.isSafeInteger(ratio) || ratio < 1) throw new TypeError('invalid durable placement ratio');
  const amount = BigInt(result.data.amount);
  const eventEpoch = BigInt(result.data.expectedEventEpoch);
  const lotNonce = BigInt(result.data.expectedLotNonce);
  const lastValidBlockHeight = BigInt(result.data.lastValidBlockHeight);
  const u64Maximum = 0xffff_ffff_ffff_ffffn;
  if (
    amount < 1n || amount > u64Maximum || eventEpoch > u64Maximum ||
    lotNonce > u64Maximum || lastValidBlockHeight > u64Maximum
  ) throw new TypeError('durable placement integer exceeds u64');
  return {
    ...result.data,
    amount,
    expectedRatioMilli: ratio,
    expectedEventEpoch: eventEpoch,
    expectedLotNonce: lotNonce,
    expiresAt: BigInt(result.data.expiresAt),
    lastValidBlockHeight,
  };
}

export function hashPlacementToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createPlacementPresenter(options: {
  readonly db: Pick<EscrowPlacementDatabase, 'getSigningSession'>;
} & EscrowPlacementServiceDependencies): (token: string) => Promise<EscrowPlacementPresentationResult> {
  return async (token) => {
    const record = await options.db.getSigningSession({
      tokenHashHex: hashPlacementToken(token),
      nowIso: options.clock().iso,
    });
    if (!record.ok) return { kind: 'rejected', code: record.code };
    let authorization: EscrowPlacementAuthorization;
    let transaction: VersionedTransaction;
    try {
      authorization = restorePlacementAuthorization(record.authorization);
      transaction = VersionedTransaction.deserialize(Buffer.from(record.rawTransactionBase64, 'base64'));
    } catch (error) {
      if (error instanceof Error) return { kind: 'rejected', code: 'invalid_input' };
      throw error;
    }
    const [observedGenesisHash, currentBlockHeight, blockhashValid] = await Promise.all([
      options.chain.genesisHash(),
      options.chain.blockHeight(),
      options.chain.isBlockhashValid(authorization.recentBlockhash),
    ]);
    if (!blockhashValid || currentBlockHeight > authorization.lastValidBlockHeight) {
      return { kind: 'rejected', code: 'session_expired' };
    }
    try {
      await verifySponsoredPositionTransactionBeforeUserSigning(transaction, {
        ...authorization,
        userWallet: record.ownerPubkey,
        marketDocumentHash: hexToBytes(authorization.marketDocumentHashHex),
        expectedGenesisHash: options.deployment.genesisHash,
        observedGenesisHash,
        currentBlockHeight,
        currentUnixTimestamp: options.clock().unix,
      });
    } catch (error) {
      if (error instanceof Error) return { kind: 'rejected', code: 'invalid_input' };
      throw error;
    }
    return {
      kind: 'found',
      schemaVersion: 1,
      rawTransactionBase64: record.rawTransactionBase64,
      authorization: record.authorization,
    };
  };
}
