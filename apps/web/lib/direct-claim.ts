import {
  assertEscrowAccountOwner,
  buildUnsignedV0Transaction,
  CLASSIC_TOKEN_PROGRAM_ID,
  decodeMarketAccount,
  decodeUserPositionAccount,
  deriveClassicAssociatedTokenAddress,
  deriveMarketPda,
  deriveSolVaultPda,
  deriveUserPositionPda,
  deriveUsdcVaultAddress,
  materializeInstruction,
  type MarketAccount,
  type UserPositionAccount,
} from '@calledit/escrow-sdk';
import { TOKEN_PROGRAM_ID, unpackAccount, unpackMint } from '@solana/spl-token';
import {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
  type SignatureStatus,
} from '@solana/web3.js';
import type { WalletAsset, WalletNetwork } from './wallet-transfers';

export type DirectClaimErrorCode =
  | 'already_claimed'
  | 'blockhash_expired'
  | 'claim_not_ready'
  | 'identity_mismatch'
  | 'insufficient_fee_balance'
  | 'network_mismatch'
  | 'onchain_failure'
  | 'rpc_unavailable'
  | 'transaction_changed';

export class DirectClaimError extends Error {
  readonly name = 'DirectClaimError';

  constructor(readonly code: DirectClaimErrorCode, options?: ErrorOptions) {
    super(code, options);
  }
}

export type DirectClaimPreparation = {
  readonly asset: WalletAsset;
  readonly canonicalUsdcMint: string;
  readonly destination: string;
  readonly expectedGenesisHash: string;
  readonly lastValidBlockHeight: bigint;
  readonly market: MarketAccount;
  readonly marketPda: string;
  readonly owner: string;
  readonly position: UserPositionAccount;
  readonly positionPda: string;
  readonly programId: string;
  readonly recentBlockhash: string;
  readonly replay: boolean;
  readonly transaction: VersionedTransaction;
};

export type DirectClaimResult =
  | { readonly kind: 'already_claimed'; readonly signature: null }
  | { readonly kind: 'finalized'; readonly signature: string }
  | { readonly kind: 'unknown'; readonly signature: string | null };

type LatestBlockhash = { readonly blockhash: string; readonly lastValidBlockHeight: number };

export interface DirectClaimRpc {
  getAccountInfo(address: PublicKey): Promise<AccountInfo<Buffer> | null>;
  getBalance(address: PublicKey): Promise<number>;
  getBlockHeight(): Promise<number>;
  getGenesisHash(): Promise<string>;
  getLatestBlockhash(): Promise<LatestBlockhash>;
  isBlockhashValid(blockhash: string): Promise<boolean>;
  sendRawTransaction(bytes: Uint8Array): Promise<string>;
  getSignatureStatus(signature: string): Promise<SignatureStatus | null>;
}

export function createDirectClaimRpc(rpcUrl: string): DirectClaimRpc {
  const connection = new Connection(resolveRpcUrl(rpcUrl), 'finalized');
  return {
    getAccountInfo: (address) => connection.getAccountInfo(address, 'finalized'),
    getBalance: (address) => connection.getBalance(address, 'finalized'),
    getBlockHeight: () => connection.getBlockHeight('finalized'),
    getGenesisHash: () => connection.getGenesisHash(),
    getLatestBlockhash: () => connection.getLatestBlockhash('finalized'),
    isBlockhashValid: (blockhash) => connection
      .isBlockhashValid(blockhash, { commitment: 'finalized' })
      .then((result) => result.value),
    sendRawTransaction: (bytes) => connection.sendRawTransaction(bytes, {
      skipPreflight: false,
      maxRetries: 3,
      preflightCommitment: 'finalized',
    }),
    getSignatureStatus: (signature) => connection
      .getSignatureStatus(signature, { searchTransactionHistory: true })
      .then((result) => result.value),
  };
}

export async function prepareDirectClaim(input: {
  readonly canonicalUsdcMint: string;
  readonly expectedGenesisHash: string;
  readonly marketId: string;
  readonly network: WalletNetwork;
  readonly owner: string;
  readonly programId: string;
  readonly rpcUrl: string;
  readonly rpc?: DirectClaimRpc;
}): Promise<DirectClaimPreparation> {
  let owner: PublicKey;
  let programId: PublicKey;
  let canonicalUsdcMint: PublicKey;
  try {
    owner = new PublicKey(input.owner);
    programId = new PublicKey(input.programId);
    canonicalUsdcMint = new PublicKey(input.canonicalUsdcMint);
  } catch (cause) {
    throw new DirectClaimError('identity_mismatch', { cause });
  }
  const marketPda = deriveMarketPda(programId, input.marketId);
  const positionPda = deriveUserPositionPda(programId, marketPda.publicKey, owner);
  const rpc = input.rpc ?? createDirectClaimRpc(input.rpcUrl);
  let genesisHash: string;
  let blockHeight: number;
  let latest: LatestBlockhash;
  let marketInfo: AccountInfo<Buffer> | null;
  let positionInfo: AccountInfo<Buffer> | null;
  let ownerLamports: number;
  try {
    [genesisHash, blockHeight, latest, marketInfo, positionInfo, ownerLamports] = await Promise.all([
      rpc.getGenesisHash(),
      rpc.getBlockHeight(),
      rpc.getLatestBlockhash(),
      rpc.getAccountInfo(marketPda.publicKey),
      rpc.getAccountInfo(positionPda.publicKey),
      rpc.getBalance(owner),
    ]);
  } catch (cause) {
    throw new DirectClaimError('rpc_unavailable', { cause });
  }
  if (genesisHash !== input.expectedGenesisHash) throw new DirectClaimError('network_mismatch');
  if (blockHeight > latest.lastValidBlockHeight) throw new DirectClaimError('blockhash_expired');
  if (marketInfo === null || positionInfo === null) throw new DirectClaimError('claim_not_ready');

  let market: MarketAccount;
  let position: UserPositionAccount;
  try {
    assertEscrowAccountOwner(marketInfo.owner, programId);
    assertEscrowAccountOwner(positionInfo.owner, programId);
    market = decodeMarketAccount(marketInfo.data);
    position = decodeUserPositionAccount(positionInfo.data);
  } catch (cause) {
    throw new DirectClaimError('transaction_changed', { cause });
  }
  const bindings = assertDirectClaimBindings({
    canonicalUsdcMint,
    market,
    marketId: input.marketId,
    marketPda: marketPda.publicKey,
    owner,
    position,
    positionPda: positionPda.publicKey,
    programId,
  });
  const destinationExists = await verifyDirectClaimAssetAccounts({
    bindings,
    canonicalUsdcMint,
    market,
    marketPda: marketPda.publicKey,
    owner,
    programId,
    rpc,
  });
  const minimumFeeLamports = market.asset === 'usdc' && !destinationExists ? 2_100_000 : 10_000;
  if (ownerLamports < minimumFeeLamports) throw new DirectClaimError('insufficient_fee_balance');
  const instruction = materializeInstruction({
    kind: 'claim_position',
    marketUuid: input.marketId,
    owner,
    asset: market.asset,
    canonicalUsdcMint,
  }, { programId });
  const transaction = buildUnsignedV0Transaction({
    feePayer: owner,
    recentBlockhash: latest.blockhash,
    instructions: [instruction],
  });
  verifyDirectClaimTransactionBeforeSigning(transaction, {
    asset: market.asset,
    canonicalUsdcMint,
    marketId: input.marketId,
    owner,
    programId,
    recentBlockhash: latest.blockhash,
  });
  return {
    asset: market.asset,
    canonicalUsdcMint: canonicalUsdcMint.toBase58(),
    destination: bindings.destination.toBase58(),
    expectedGenesisHash: input.expectedGenesisHash,
    lastValidBlockHeight: BigInt(latest.lastValidBlockHeight),
    market,
    marketPda: marketPda.address,
    owner: owner.toBase58(),
    position,
    positionPda: positionPda.address,
    programId: programId.toBase58(),
    recentBlockhash: latest.blockhash,
    replay: market.replay,
    transaction,
  };
}

export function assertDirectClaimBindings(input: {
  readonly canonicalUsdcMint: PublicKey;
  readonly market: MarketAccount;
  readonly marketId: string;
  readonly marketPda: PublicKey;
  readonly owner: PublicKey;
  readonly position: UserPositionAccount;
  readonly positionPda: PublicKey;
  readonly programId: PublicKey;
}): { readonly destination: PublicKey; readonly vault: PublicKey } {
  if (input.market.marketUuid !== input.marketId) throw new DirectClaimError('transaction_changed');
  if (input.market.state !== 'settled' && input.market.state !== 'voided') {
    throw new DirectClaimError('claim_not_ready');
  }
  if (input.market.state === 'settled' && !input.position.settlementProcessed) {
    throw new DirectClaimError('claim_not_ready');
  }
  if (input.position.claimed) throw new DirectClaimError('already_claimed');
  if (
    input.position.market !== input.marketPda.toBase58() ||
    input.position.owner !== input.owner.toBase58()
  ) {
    throw new DirectClaimError('identity_mismatch');
  }
  const expectedPosition = deriveUserPositionPda(input.programId, input.marketPda, input.owner).publicKey;
  if (!expectedPosition.equals(input.positionPda)) throw new DirectClaimError('identity_mismatch');

  const expectedMint = input.market.asset === 'usdc'
    ? input.canonicalUsdcMint.toBase58()
    : null;
  if (input.market.tokenMint !== expectedMint) throw new DirectClaimError('transaction_changed');
  const vault = input.market.asset === 'sol'
    ? deriveSolVaultPda(input.programId, input.marketPda).publicKey
    : deriveUsdcVaultAddress(input.marketPda, input.canonicalUsdcMint);
  if (input.market.vault !== vault.toBase58()) throw new DirectClaimError('transaction_changed');
  const destination = input.market.asset === 'sol'
    ? input.owner
    : deriveClassicAssociatedTokenAddress(input.owner, input.canonicalUsdcMint);
  return { destination, vault };
}

async function verifyDirectClaimAssetAccounts(input: {
  readonly bindings: { readonly destination: PublicKey; readonly vault: PublicKey };
  readonly canonicalUsdcMint: PublicKey;
  readonly market: MarketAccount;
  readonly marketPda: PublicKey;
  readonly owner: PublicKey;
  readonly programId: PublicKey;
  readonly rpc: DirectClaimRpc;
}): Promise<boolean> {
  let vaultInfo: AccountInfo<Buffer> | null;
  let mintInfo: AccountInfo<Buffer> | null = null;
  let destinationInfo: AccountInfo<Buffer> | null = null;
  try {
    [vaultInfo, mintInfo, destinationInfo] = input.market.asset === 'sol'
      ? [await input.rpc.getAccountInfo(input.bindings.vault), null, null]
      : await Promise.all([
        input.rpc.getAccountInfo(input.bindings.vault),
        input.rpc.getAccountInfo(input.canonicalUsdcMint),
        input.rpc.getAccountInfo(input.bindings.destination),
      ]);
  } catch (cause) {
    throw new DirectClaimError('rpc_unavailable', { cause });
  }
  if (vaultInfo === null) throw new DirectClaimError('transaction_changed');
  if (input.market.asset === 'sol') {
    if (!vaultInfo.owner.equals(input.programId) || vaultInfo.data.length !== 0) {
      throw new DirectClaimError('transaction_changed');
    }
    return true;
  }
  if (!CLASSIC_TOKEN_PROGRAM_ID.equals(TOKEN_PROGRAM_ID) || mintInfo === null) {
    throw new DirectClaimError('transaction_changed');
  }
  try {
    const mint = unpackMint(input.canonicalUsdcMint, mintInfo, TOKEN_PROGRAM_ID);
    const vault = unpackAccount(input.bindings.vault, vaultInfo, TOKEN_PROGRAM_ID);
    if (
      !mint.isInitialized || mint.decimals !== 6 ||
      !vault.isInitialized || vault.isFrozen ||
      !vault.mint.equals(input.canonicalUsdcMint) ||
      !vault.owner.equals(input.marketPda)
    ) throw new DirectClaimError('transaction_changed');
    if (destinationInfo !== null) {
      const destination = unpackAccount(input.bindings.destination, destinationInfo, TOKEN_PROGRAM_ID);
      if (
        !destination.isInitialized || destination.isFrozen ||
        !destination.mint.equals(input.canonicalUsdcMint) ||
        !destination.owner.equals(input.owner)
      ) throw new DirectClaimError('transaction_changed');
    }
  } catch (cause) {
    if (cause instanceof DirectClaimError) throw cause;
    throw new DirectClaimError('transaction_changed', { cause });
  }
  return destinationInfo !== null;
}

export function verifyDirectClaimTransactionBeforeSigning(
  transaction: VersionedTransaction,
  expected: DirectClaimMessageExpectation,
): void {
  verifyDirectClaimMessage(transaction, expected);
  const signature = transaction.signatures[0];
  if (signature === undefined || !signature.every((byte) => byte === 0)) {
    throw new DirectClaimError('transaction_changed');
  }
}

export async function verifySignedDirectClaim(
  signedBytes: Uint8Array,
  preparation: DirectClaimPreparation,
): Promise<VersionedTransaction> {
  let signed: VersionedTransaction;
  try {
    signed = VersionedTransaction.deserialize(signedBytes);
  } catch (cause) {
    throw new DirectClaimError('transaction_changed', { cause });
  }
  verifyDirectClaimMessage(signed, {
    asset: preparation.asset,
    canonicalUsdcMint: new PublicKey(preparation.canonicalUsdcMint),
    marketId: preparation.market.marketUuid,
    owner: new PublicKey(preparation.owner),
    programId: new PublicKey(preparation.programId),
    recentBlockhash: preparation.recentBlockhash,
  });
  if (!equalBytes(preparation.transaction.message.serialize(), signed.message.serialize())) {
    throw new DirectClaimError('transaction_changed');
  }
  const signature = signed.signatures[0];
  if (signature === undefined || signature.every((byte) => byte === 0)) {
    throw new DirectClaimError('transaction_changed');
  }
  if (!await validEd25519Signature(new PublicKey(preparation.owner), signature, signed.message.serialize())) {
    throw new DirectClaimError('transaction_changed');
  }
  return signed;
}

export async function submitDirectClaim(input: {
  readonly preparation: DirectClaimPreparation;
  readonly rpcUrl: string;
  readonly signedBytes: Uint8Array;
  readonly rpc?: DirectClaimRpc;
  readonly pollAttempts?: number;
  readonly pollDelayMs?: number;
}): Promise<DirectClaimResult> {
  const rpc = input.rpc ?? createDirectClaimRpc(input.rpcUrl);
  const signed = await verifySignedDirectClaim(input.signedBytes, input.preparation);
  if (await positionClaimed(rpc, input.preparation)) return { kind: 'already_claimed', signature: null };
  try {
    const [genesis, blockHeight, valid] = await Promise.all([
      rpc.getGenesisHash(),
      rpc.getBlockHeight(),
      rpc.isBlockhashValid(input.preparation.recentBlockhash),
    ]);
    if (genesis !== input.preparation.expectedGenesisHash) throw new DirectClaimError('network_mismatch');
    if (!valid || BigInt(blockHeight) > input.preparation.lastValidBlockHeight) {
      throw new DirectClaimError('blockhash_expired');
    }
  } catch (cause) {
    if (cause instanceof DirectClaimError) throw cause;
    throw new DirectClaimError('rpc_unavailable', { cause });
  }
  let signature: string;
  try {
    signature = await rpc.sendRawTransaction(signed.serialize());
  } catch {
    try {
      if (await positionClaimed(rpc, input.preparation)) return { kind: 'already_claimed', signature: null };
    } catch {
      // A submit timeout is unknown unless finalized state proves the claim landed.
    }
    return { kind: 'unknown', signature: null };
  }
  const attempts = input.pollAttempts ?? 24;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let status: SignatureStatus | null;
    try {
      status = await rpc.getSignatureStatus(signature);
    } catch {
      status = null;
    }
    if (status?.err !== null && status?.err !== undefined) {
      if (await positionClaimed(rpc, input.preparation)) return { kind: 'finalized', signature };
      throw new DirectClaimError('onchain_failure');
    }
    if (status?.confirmationStatus === 'finalized' && await positionClaimed(rpc, input.preparation)) {
      return { kind: 'finalized', signature };
    }
    await delay(input.pollDelayMs ?? 1_500);
  }
  return { kind: 'unknown', signature };
}

type DirectClaimMessageExpectation = {
  readonly asset: WalletAsset;
  readonly canonicalUsdcMint: PublicKey;
  readonly marketId: string;
  readonly owner: PublicKey;
  readonly programId: PublicKey;
  readonly recentBlockhash: string;
};

function verifyDirectClaimMessage(
  transaction: VersionedTransaction,
  expected: DirectClaimMessageExpectation,
): void {
  if (transaction.message.addressTableLookups.length !== 0) throw new DirectClaimError('transaction_changed');
  if (transaction.message.recentBlockhash !== expected.recentBlockhash) {
    throw new DirectClaimError('transaction_changed');
  }
  const required = transaction.message.staticAccountKeys.slice(
    0,
    transaction.message.header.numRequiredSignatures,
  );
  if (required.length !== 1 || !required[0]?.equals(expected.owner)) {
    throw new DirectClaimError('identity_mismatch');
  }
  const instruction = materializeInstruction({
    kind: 'claim_position',
    marketUuid: expected.marketId,
    owner: expected.owner,
    asset: expected.asset,
    canonicalUsdcMint: expected.canonicalUsdcMint,
  }, { programId: expected.programId });
  const exactMessage = new TransactionMessage({
    payerKey: expected.owner,
    recentBlockhash: expected.recentBlockhash,
    instructions: [instruction],
  }).compileToV0Message();
  if (!equalBytes(transaction.message.serialize(), exactMessage.serialize())) {
    throw new DirectClaimError('transaction_changed');
  }
}

async function positionClaimed(
  rpc: DirectClaimRpc,
  preparation: DirectClaimPreparation,
): Promise<boolean> {
  const info = await rpc.getAccountInfo(new PublicKey(preparation.positionPda));
  if (info === null) return false;
  try {
    assertEscrowAccountOwner(info.owner, preparation.programId);
    const position = decodeUserPositionAccount(info.data);
    if (position.owner !== preparation.owner || position.market !== preparation.marketPda) {
      throw new DirectClaimError('identity_mismatch');
    }
    return position.claimed;
  } catch (cause) {
    throw new DirectClaimError('transaction_changed', { cause });
  }
}

async function validEd25519Signature(
  publicKey: PublicKey,
  signature: Uint8Array,
  message: Uint8Array,
): Promise<boolean> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    ownedBuffer(publicKey.toBytes()),
    'Ed25519',
    false,
    ['verify'],
  );
  return globalThis.crypto.subtle.verify(
    'Ed25519',
    key,
    ownedBuffer(signature),
    ownedBuffer(message),
  );
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function resolveRpcUrl(value: string): string {
  if (/^https?:\/\//.test(value)) return value;
  if (typeof window === 'undefined') throw new DirectClaimError('rpc_unavailable');
  return new URL(value, window.location.origin).toString();
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}
