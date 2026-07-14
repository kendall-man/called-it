import {
  assertEscrowAccountOwner,
  decodeMarketAccount,
  deriveMarketPda,
  EscrowTransactionVerificationError,
  verifySponsoredPositionTransaction,
  verifySponsoredPositionTransactionBeforeUserSigning,
  type MarketAccount,
} from '@calledit/escrow-sdk';
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import type { PositionAuthorization } from './position-contract';
import { positionAuthorizationForSdk } from './position-contract';
import { walletBalances, type WalletAsset, type WalletNetwork } from './wallet-transfers';

export type PositionChainErrorCode =
  | 'asset_mismatch'
  | 'expired_blockhash'
  | 'insufficient_balance'
  | 'market_closed'
  | 'market_frozen'
  | 'network_mismatch'
  | 'quote_changed'
  | 'rpc_unavailable'
  | 'transaction_changed';

export class PositionChainError extends Error {
  readonly name = 'PositionChainError';

  constructor(readonly code: PositionChainErrorCode, options?: ErrorOptions) {
    super(code, options);
  }
}

export type VerifiedPositionPreparation = {
  readonly authorization: PositionAuthorization;
  readonly balances: Readonly<Record<WalletAsset, bigint>>;
  readonly currentMatchedPercent: number;
  readonly lockedMultiplier: string;
  readonly market: MarketAccount;
  readonly maxPossibleReturnAtomic: bigint;
  readonly transaction: VersionedTransaction;
};

export async function verifyPositionPreparation(input: {
  readonly authorization: PositionAuthorization;
  readonly canonicalUsdcMint: string;
  readonly expectedProgramId: string;
  readonly network: WalletNetwork;
  readonly ownerPubkey: string;
  readonly rawTransactionBase64: string;
  readonly rpcUrl: string;
}): Promise<VerifiedPositionPreparation> {
  const transaction = transactionFromBase64(input.rawTransactionBase64);
  const connection = new Connection(resolveRpcUrl(input.rpcUrl), 'confirmed');
  const marketPda = deriveMarketPda(input.expectedProgramId, input.authorization.marketUuid);
  if (
    input.authorization.programId !== input.expectedProgramId ||
    input.authorization.canonicalUsdcMint !== input.canonicalUsdcMint ||
    input.authorization.marketPda !== marketPda.address
  ) {
    throw new PositionChainError('transaction_changed');
  }

  let genesisHash: string;
  let blockHeight: number;
  let marketInfo: Awaited<ReturnType<Connection['getAccountInfo']>>;
  let balances: Readonly<Record<WalletAsset, bigint>>;
  try {
    [genesisHash, blockHeight, marketInfo, balances] = await Promise.all([
      connection.getGenesisHash(),
      connection.getBlockHeight('confirmed'),
      connection.getAccountInfo(marketPda.publicKey, 'confirmed'),
      walletBalances(
        input.rpcUrl,
        new PublicKey(input.ownerPubkey),
        input.network,
        input.canonicalUsdcMint,
      ),
    ]);
  } catch (cause) {
    throw new PositionChainError('rpc_unavailable', { cause });
  }
  if (genesisHash !== input.authorization.genesisHash) {
    throw new PositionChainError('network_mismatch');
  }
  if (marketInfo === null) throw new PositionChainError('market_closed');
  try {
    assertEscrowAccountOwner(marketInfo.owner, input.expectedProgramId);
  } catch (cause) {
    throw new PositionChainError('transaction_changed', { cause });
  }
  let market: MarketAccount;
  try {
    market = decodeMarketAccount(marketInfo.data);
  } catch (cause) {
    throw new PositionChainError('transaction_changed', { cause });
  }
  const now = BigInt(Math.floor(Date.now() / 1_000));
  assertMarketBindings(market, input.authorization, now, input.canonicalUsdcMint);
  try {
    await verifySponsoredPositionTransactionBeforeUserSigning(transaction, {
      ...positionAuthorizationForSdk(input.authorization),
      userWallet: input.ownerPubkey,
      expectedGenesisHash: input.authorization.genesisHash,
      observedGenesisHash: genesisHash,
      recentBlockhash: input.authorization.recentBlockhash,
      lastValidBlockHeight: BigInt(input.authorization.lastValidBlockHeight),
      currentBlockHeight: BigInt(blockHeight),
      currentUnixTimestamp: now,
    });
  } catch (cause) {
    throw mapSdkError(cause);
  }
  const amount = BigInt(input.authorization.amount);
  if (balances[input.authorization.asset] < amount) {
    throw new PositionChainError('insufficient_balance');
  }
  const metrics = positionMetrics(market, input.authorization.side, amount);
  return {
    authorization: input.authorization,
    balances,
    market,
    transaction,
    ...metrics,
  };
}

export async function verifySignedPosition(
  preparation: VerifiedPositionPreparation,
  ownerPubkey: string,
  signedBytes: Uint8Array,
  rpcUrl: string,
): Promise<VersionedTransaction> {
  let signed: VersionedTransaction;
  try {
    signed = VersionedTransaction.deserialize(signedBytes);
  } catch (cause) {
    throw new PositionChainError('transaction_changed', { cause });
  }
  if (!sameBytes(preparation.transaction.message.serialize(), signed.message.serialize())) {
    throw new PositionChainError('transaction_changed');
  }
  const connection = new Connection(resolveRpcUrl(rpcUrl), 'confirmed');
  let observedGenesisHash: string;
  let currentBlockHeight: number;
  let blockhashValid: boolean;
  try {
    [observedGenesisHash, currentBlockHeight, blockhashValid] = await Promise.all([
      connection.getGenesisHash(),
      connection.getBlockHeight('confirmed'),
      connection.isBlockhashValid(preparation.authorization.recentBlockhash, { commitment: 'confirmed' })
        .then((result) => result.value),
    ]);
  } catch (cause) {
    throw new PositionChainError('rpc_unavailable', { cause });
  }
  if (!blockhashValid) throw new PositionChainError('expired_blockhash');
  try {
    await verifySponsoredPositionTransaction(signed, {
      ...positionAuthorizationForSdk(preparation.authorization),
      userWallet: ownerPubkey,
      expectedGenesisHash: preparation.authorization.genesisHash,
      observedGenesisHash,
      recentBlockhash: preparation.authorization.recentBlockhash,
      lastValidBlockHeight: BigInt(preparation.authorization.lastValidBlockHeight),
      currentBlockHeight: BigInt(currentBlockHeight),
      currentUnixTimestamp: BigInt(Math.floor(Date.now() / 1_000)),
      requireRelayerSignature: true,
    });
  } catch (cause) {
    throw mapSdkError(cause);
  }
  return signed;
}

export function transactionToBase64(transaction: VersionedTransaction): string {
  const bytes = transaction.serialize();
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function transactionFromBase64(value: string): VersionedTransaction {
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return VersionedTransaction.deserialize(bytes);
  } catch (cause) {
    throw new PositionChainError('transaction_changed', { cause });
  }
}

function assertMarketBindings(
  market: MarketAccount,
  authorization: PositionAuthorization,
  now: bigint,
  canonicalUsdcMint: string,
): void {
  const expectedMint = authorization.asset === 'usdc' ? canonicalUsdcMint : null;
  if (
    market.marketUuid !== authorization.marketUuid ||
    hex(market.marketDocumentHash) !== authorization.marketDocumentHashHex ||
    market.ratioMilli !== Number(authorization.expectedRatioMilli) ||
    market.eventEpoch !== BigInt(authorization.expectedEventEpoch)
  ) {
    throw new PositionChainError('quote_changed');
  }
  if (market.asset !== authorization.asset || market.tokenMint !== expectedMint) {
    throw new PositionChainError('asset_mismatch');
  }
  if (market.state === 'frozen') throw new PositionChainError('market_frozen');
  if (
    market.state !== 'open' ||
    now >= market.positionCutoffTimestamp ||
    now >= BigInt(authorization.expiresAt)
  ) {
    throw new PositionChainError('market_closed');
  }
}

export function positionMetrics(
  market: Pick<MarketAccount, 'activeBackTotal' | 'activeDoubtTotal' | 'ratioMilli'>,
  side: 'back' | 'doubt',
  amount: bigint,
): {
  readonly currentMatchedPercent: number;
  readonly lockedMultiplier: string;
  readonly maxPossibleReturnAtomic: bigint;
} {
  const ratio = BigInt(market.ratioMilli);
  const back = market.activeBackTotal + (side === 'back' ? amount : 0n);
  const doubt = market.activeDoubtTotal + (side === 'doubt' ? amount : 0n);
  const matchedBack = min(back, (doubt * 1_000n) / ratio);
  const matchedDoubt = min(doubt, (matchedBack * ratio) / 1_000n);
  const sideTotal = side === 'back' ? back : doubt;
  const matchedSide = side === 'back' ? matchedBack : matchedDoubt;
  const basisPoints = sideTotal === 0n ? 0n : (matchedSide * 10_000n) / sideTotal;
  const profit = side === 'back'
    ? (amount * ratio) / 1_000n
    : (amount * 1_000n) / ratio;
  const multiplierMilli = side === 'back' ? 1_000n + ratio : 1_000n + (1_000_000n / ratio);
  return {
    currentMatchedPercent: Number(basisPoints) / 100,
    lockedMultiplier: `${formatScaled(multiplierMilli, 3)}x`,
    maxPossibleReturnAtomic: amount + profit,
  };
}

function formatScaled(value: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
}

function min(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function mapSdkError(cause: unknown): PositionChainError {
  if (!(cause instanceof EscrowTransactionVerificationError)) {
    return new PositionChainError('transaction_changed', { cause });
  }
  if (cause.code === 'network_mismatch') return new PositionChainError('network_mismatch');
  if (cause.code === 'expired_blockhash' || cause.code === 'stale_intent') {
    return new PositionChainError('expired_blockhash');
  }
  return new PositionChainError('transaction_changed', { cause });
}

function resolveRpcUrl(value: string): string {
  if (/^https?:\/\//.test(value)) return value;
  if (typeof window === 'undefined') throw new PositionChainError('rpc_unavailable');
  return new URL(value, window.location.origin).toString();
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
