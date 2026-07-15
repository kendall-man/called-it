import { createHash } from 'node:crypto';
import {
  assertEscrowAccountOwner,
  buildUnsignedV0Transaction,
  CLASSIC_TOKEN_PROGRAM_ID,
  decodeMarketAccount,
  decodeProtocolConfigAccount,
  decodeUserPositionAccount,
  deriveClassicAssociatedTokenAddress,
  deriveMarketPda,
  deriveProtocolConfigPda,
  deriveSolVaultPda,
  deriveUsdcVaultAddress,
  deriveUserPositionPda,
  materializeInstruction,
  type MarketAccount,
  type UserPositionAccount,
} from '@calledit/escrow-sdk';
import {
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
  type TransactionInstruction,
} from '@solana/web3.js';
import { RecoveryError, fail } from './errors.js';
import type { RecoveryAccountSnapshot, RecoveryRpc } from './rpc.js';

export const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const DEVNET_WRITE_CONSENT = 'I_UNDERSTAND_THIS_WRITES_TO_SOLANA_DEVNET';

export type RecoveryOperation = 'inspect' | 'claim' | 'refund' | 'timeout-refund';
export type RecoveryEligibility = 'already-recovered' | 'claim' | 'refund' | 'timeout-refund' | 'not-ready';

export interface PrepareRecoveryInput {
  readonly operation: RecoveryOperation;
  readonly expectedGenesisHash: string;
  readonly programId: string;
  readonly canonicalUsdcMint: string;
  readonly marketUuid: string;
  readonly owner: string;
  readonly rpc: RecoveryRpc;
}

export interface RecoveryPreparation {
  readonly operation: RecoveryOperation;
  readonly expectedGenesisHash: string;
  readonly programId: PublicKey;
  readonly canonicalUsdcMint: PublicKey;
  readonly configPda: PublicKey;
  readonly marketPda: PublicKey;
  readonly positionPda: PublicKey;
  readonly owner: PublicKey;
  readonly market: MarketAccount;
  readonly position: UserPositionAccount;
  readonly destination: PublicKey;
  readonly destinationKind: 'owner-wallet' | 'canonical-associated-token-account';
  readonly eligibility: RecoveryEligibility;
  readonly expectedAmount: bigint | null;
  readonly observedSlot: bigint;
  readonly observedBlockTime: bigint;
  readonly transaction: VersionedTransaction | null;
  readonly recentBlockhash: string | null;
  readonly lastValidBlockHeight: bigint | null;
  readonly ownerBalanceLamports: bigint;
  readonly estimatedFeeLamports: bigint;
  readonly requiredAtaRentLamports: bigint;
}

export interface RecoverySubmission {
  readonly status: 'finalized' | 'unknown' | 'already-recovered';
  readonly signature: string | null;
  readonly finalizedSlot: bigint | null;
}

export interface RecoveryEvidence {
  readonly schemaVersion: 1;
  readonly kind: 'calledit-escrow-recovery';
  readonly generatedAt: string;
  readonly mode: 'inspect' | 'dry-run' | 'submitted';
  readonly status: 'ready' | 'not-ready' | 'already-recovered' | 'finalized' | 'unknown';
  readonly operation: RecoveryOperation;
  readonly chain: {
    readonly commitment: 'finalized';
    readonly genesisHash: string;
    readonly observedSlot: string;
    readonly observedBlockTime: string;
  };
  readonly deployment: {
    readonly programId: string;
    readonly configPda: string;
    readonly canonicalUsdcMint: string;
  };
  readonly market: {
    readonly marketUuid: string;
    readonly marketPda: string;
    readonly state: string;
    readonly replay: boolean;
    readonly asset: 'sol' | 'usdc';
    readonly vault: string;
    readonly resolutionDeadline: string;
  };
  readonly position: {
    readonly positionPda: string;
    readonly owner: string;
    readonly side: 'back' | 'doubt';
    readonly claimed: boolean;
    readonly settlementProcessed: boolean;
    readonly totalPaidAmountAtomic: string;
  };
  readonly recovery: {
    readonly eligibility: RecoveryEligibility;
    readonly destination: string;
    readonly destinationKind: 'owner-wallet' | 'canonical-associated-token-account';
    readonly expectedAmountAtomic: string | null;
  };
  readonly transaction: null | {
    readonly instructionKinds: readonly ('timeout_void' | 'claim_position')[];
    readonly recentBlockhash: string;
    readonly lastValidBlockHeight: string;
    readonly messageSha256: string;
    readonly unsignedTransactionBase64: string;
    readonly estimatedFeeLamports: string;
    readonly requiredAtaRentLamports: string;
    readonly ownerBalanceLamports: string;
    readonly feeBalanceSufficient: boolean;
  };
  readonly submission: null | {
    readonly status: RecoverySubmission['status'];
    readonly signature: string | null;
    readonly finalizedSlot: string | null;
  };
}

export async function prepareRecovery(input: PrepareRecoveryInput): Promise<RecoveryPreparation> {
  const identities = parseIdentities(input);
  const { rpc } = input;
  const initial = await rpcCall(() => Promise.all([
    rpc.genesisHash(),
    rpc.accounts([
      identities.programId,
      identities.configPda,
      identities.marketPda,
      identities.positionPda,
    ]),
  ]));
  const [genesisHash, snapshot] = initial;
  if (genesisHash !== input.expectedGenesisHash) fail('network_mismatch', 'RPC genesis hash does not match the pinned genesis hash');

  const expectedGenesisBytes = publicKey(input.expectedGenesisHash, 'genesis hash').toBytes();
  const programInfo = requiredAccount(snapshot, 0, 'escrow program');
  const configInfo = requiredAccount(snapshot, 1, 'protocol config');
  const marketInfo = requiredAccount(snapshot, 2, 'market');
  const positionInfo = requiredAccount(snapshot, 3, 'owner position');
  if (!programInfo.executable) fail('program_mismatch', 'pinned escrow program account is not executable');

  const config = decodeOwned(configInfo, identities.programId, decodeProtocolConfigAccount, 'protocol config');
  if (!equalBytes(config.clusterGenesisHash, expectedGenesisBytes)) {
    fail('network_mismatch', 'protocol config genesis hash does not match the pinned cluster');
  }
  if (config.canonicalUsdcMint !== identities.canonicalUsdcMint.toBase58()) {
    fail('mint_mismatch', 'protocol config canonical USDC mint does not match the pinned mint');
  }
  if (config.allowedTokenProgram !== CLASSIC_TOKEN_PROGRAM_ID.toBase58()) {
    fail('mint_mismatch', 'protocol config does not use the classic SPL Token program');
  }

  const market = decodeOwned(marketInfo, identities.programId, decodeMarketAccount, 'market');
  const position = decodeOwned(positionInfo, identities.programId, decodeUserPositionAccount, 'owner position');
  assertMarketAndOwnerBindings({ ...identities, market, position, marketUuid: input.marketUuid });

  const destination = market.asset === 'sol'
    ? identities.owner
    : deriveClassicAssociatedTokenAddress(identities.owner, identities.canonicalUsdcMint);
  const assetSnapshot = await rpcCall(() => rpc.accounts(
    market.asset === 'sol'
      ? [new PublicKey(market.vault)]
      : [new PublicKey(market.vault), identities.canonicalUsdcMint, destination],
    snapshot.slot,
  ));
  const destinationExists = verifyAssetAccounts({
    snapshot: assetSnapshot,
    market,
    marketPda: identities.marketPda,
    programId: identities.programId,
    canonicalUsdcMint: identities.canonicalUsdcMint,
    destination,
    owner: identities.owner,
  });
  const observedSlot = assetSnapshot.slot > snapshot.slot ? assetSnapshot.slot : snapshot.slot;
  const observedBlockTime = await rpcCall(() => rpc.blockTime(observedSlot));
  const eligibility = recoveryEligibility(market, position, observedBlockTime);
  enforceOperation(input.operation, eligibility);
  const expectedAmount = recoverableAmount(market, position, eligibility);

  if (input.operation === 'inspect') {
    return {
      operation: input.operation,
      expectedGenesisHash: input.expectedGenesisHash,
      ...identities,
      market,
      position,
      destination,
      destinationKind: market.asset === 'sol' ? 'owner-wallet' : 'canonical-associated-token-account',
      eligibility,
      expectedAmount,
      observedSlot,
      observedBlockTime,
      transaction: null,
      recentBlockhash: null,
      lastValidBlockHeight: null,
      ownerBalanceLamports: 0n,
      estimatedFeeLamports: 0n,
      requiredAtaRentLamports: 0n,
    };
  }

  const latest = await rpcCall(() => rpc.latestBlockhash());
  const transaction = buildRecoveryTransaction({
    operation: input.operation,
    programId: identities.programId,
    canonicalUsdcMint: identities.canonicalUsdcMint,
    marketUuid: input.marketUuid,
    owner: identities.owner,
    asset: market.asset,
    recentBlockhash: latest.blockhash,
  });
  verifyRecoveryTransaction(transaction, {
    operation: input.operation,
    programId: identities.programId,
    canonicalUsdcMint: identities.canonicalUsdcMint,
    marketUuid: input.marketUuid,
    owner: identities.owner,
    asset: market.asset,
    recentBlockhash: latest.blockhash,
  });
  const [ownerBalanceLamports, estimatedFeeLamports, requiredAtaRentLamports] = await rpcCall(() => Promise.all([
    rpc.balance(identities.owner),
    rpc.feeForMessage(transaction.message),
    market.asset === 'usdc' && !destinationExists ? rpc.minimumTokenAccountRent() : Promise.resolve(0n),
  ]));

  return {
    operation: input.operation,
    expectedGenesisHash: input.expectedGenesisHash,
    ...identities,
    market,
    position,
    destination,
    destinationKind: market.asset === 'sol' ? 'owner-wallet' : 'canonical-associated-token-account',
    eligibility,
    expectedAmount,
    observedSlot,
    observedBlockTime,
    transaction,
    recentBlockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    ownerBalanceLamports,
    estimatedFeeLamports,
    requiredAtaRentLamports,
  };
}

interface TransactionExpectation {
  readonly operation: Exclude<RecoveryOperation, 'inspect'>;
  readonly programId: PublicKey;
  readonly canonicalUsdcMint: PublicKey;
  readonly marketUuid: string;
  readonly owner: PublicKey;
  readonly asset: 'sol' | 'usdc';
  readonly recentBlockhash: string;
}

function buildRecoveryTransaction(expected: TransactionExpectation): VersionedTransaction {
  return buildUnsignedV0Transaction({
    feePayer: expected.owner,
    recentBlockhash: expected.recentBlockhash,
    instructions: recoveryInstructions(expected),
  });
}

function recoveryInstructions(expected: TransactionExpectation): readonly TransactionInstruction[] {
  const claim = materializeInstruction({
    kind: 'claim_position',
    marketUuid: expected.marketUuid,
    owner: expected.owner,
    asset: expected.asset,
    canonicalUsdcMint: expected.canonicalUsdcMint,
  }, { programId: expected.programId });
  return expected.operation === 'timeout-refund'
    ? [materializeInstruction({ kind: 'timeout_void', marketUuid: expected.marketUuid }, { programId: expected.programId }), claim]
    : [claim];
}

export function verifyRecoveryTransaction(
  transaction: VersionedTransaction,
  expected: TransactionExpectation,
): void {
  if (transaction.message.addressTableLookups.length !== 0) {
    fail('transaction_mismatch', 'recovery transaction must not use address lookup tables');
  }
  const required = transaction.message.staticAccountKeys.slice(0, transaction.message.header.numRequiredSignatures);
  if (required.length !== 1 || !required[0]?.equals(expected.owner)) {
    fail('identity_mismatch', 'recovery transaction must require only the recorded owner signature');
  }
  const exact = new TransactionMessage({
    payerKey: expected.owner,
    recentBlockhash: expected.recentBlockhash,
    instructions: [...recoveryInstructions(expected)],
  }).compileToV0Message();
  if (!equalBytes(transaction.message.serialize(), exact.serialize())) {
    fail('transaction_mismatch', 'recovery transaction message differs from the verified recovery action');
  }
  if (transaction.signatures.length !== 1 || transaction.signatures[0]?.some((byte) => byte !== 0)) {
    fail('transaction_mismatch', 'dry-run recovery transaction must be unsigned');
  }
}

export function assertDevnetWriteConsent(preparation: RecoveryPreparation, consent: string | undefined): void {
  if (preparation.operation === 'inspect' || preparation.transaction === null) {
    fail('submission_forbidden', 'inspect does not create a transaction');
  }
  if (preparation.expectedGenesisHash !== DEVNET_GENESIS_HASH) {
    fail('submission_forbidden', 'this client permits direct submission only on canonical Solana devnet');
  }
  if (consent !== DEVNET_WRITE_CONSENT) {
    fail('submission_forbidden', `devnet submission requires the exact consent token ${DEVNET_WRITE_CONSENT}`);
  }
}

export async function submitRecovery(input: {
  readonly preparation: RecoveryPreparation;
  readonly ownerKeypair: Keypair;
  readonly devnetWriteConsent: string;
  readonly rpc: RecoveryRpc;
  readonly pollAttempts?: number;
  readonly pollDelayMs?: number;
}): Promise<RecoverySubmission> {
  const preparation = input.preparation;
  assertDevnetWriteConsent(preparation, input.devnetWriteConsent);
  if (preparation.transaction === null || preparation.recentBlockhash === null || preparation.lastValidBlockHeight === null) {
    fail('submission_forbidden', 'recovery preparation does not contain a transaction');
  }
  if (!input.ownerKeypair.publicKey.equals(preparation.owner)) {
    fail('identity_mismatch', 'signing keypair does not match the recorded position owner');
  }
  const requiredFees = preparation.estimatedFeeLamports + preparation.requiredAtaRentLamports;
  if (preparation.ownerBalanceLamports < requiredFees) {
    fail('insufficient_fee_balance', 'owner wallet cannot cover the transaction fee and required token-account rent');
  }
  const operation = preparation.operation;
  if (operation === 'inspect') fail('submission_forbidden', 'inspect does not create a transaction');
  verifyRecoveryTransaction(preparation.transaction, {
    operation,
    programId: preparation.programId,
    canonicalUsdcMint: preparation.canonicalUsdcMint,
    marketUuid: preparation.market.marketUuid,
    owner: preparation.owner,
    asset: preparation.market.asset,
    recentBlockhash: preparation.recentBlockhash,
  });
  const [genesis, blockHeight, valid] = await rpcCall(() => Promise.all([
    input.rpc.genesisHash(),
    input.rpc.blockHeight(),
    input.rpc.blockhashValid(preparation.recentBlockhash!),
  ]));
  if (genesis !== preparation.expectedGenesisHash || genesis !== DEVNET_GENESIS_HASH) {
    fail('network_mismatch', 'RPC no longer reports canonical Solana devnet');
  }
  if (!valid || blockHeight > preparation.lastValidBlockHeight) {
    fail('blockhash_expired', 'recovery transaction blockhash expired before signing');
  }
  if (await ownerPositionClaimed(input.rpc, preparation)) {
    return { status: 'already-recovered', signature: null, finalizedSlot: null };
  }

  const signedTransaction = VersionedTransaction.deserialize(preparation.transaction.serialize());
  signedTransaction.sign([input.ownerKeypair]);
  const signatureBytes = signedTransaction.signatures[0];
  if (signatureBytes === undefined || signatureBytes.every((byte) => byte === 0)) {
    fail('transaction_mismatch', 'owner signature was not applied');
  }
  let signature: string;
  try {
    signature = await input.rpc.sendRawTransaction(signedTransaction.serialize());
  } catch {
    return { status: 'unknown', signature: null, finalizedSlot: null };
  }

  const attempts = input.pollAttempts ?? 40;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const status = await input.rpc.signatureStatus(signature).catch(() => null);
    if (status?.err !== null && status?.err !== undefined) {
      if (await ownerPositionClaimed(input.rpc, preparation)) {
        return { status: 'already-recovered', signature: null, finalizedSlot: null };
      }
      fail('onchain_failure', 'recovery transaction failed on-chain');
    }
    if (status?.confirmationStatus === 'finalized') {
      if (!await ownerPositionClaimed(input.rpc, preparation)) {
        fail('onchain_failure', 'finalized recovery transaction did not mark the owner position claimed');
      }
      return { status: 'finalized', signature, finalizedSlot: status.slot === undefined ? null : BigInt(status.slot) };
    }
    if (await ownerPositionClaimed(input.rpc, preparation)) {
      return { status: 'already-recovered', signature: null, finalizedSlot: null };
    }
    await delay(input.pollDelayMs ?? 1_500);
  }
  return { status: 'unknown', signature, finalizedSlot: null };
}

export function recoveryEvidence(
  preparation: RecoveryPreparation,
  submission: RecoverySubmission | null = null,
  now: Date = new Date(),
): RecoveryEvidence {
  const transaction = preparation.transaction;
  const requiredFees = preparation.estimatedFeeLamports + preparation.requiredAtaRentLamports;
  const status = submission?.status === 'finalized'
    ? 'finalized'
    : submission?.status === 'unknown'
      ? 'unknown'
      : preparation.eligibility === 'already-recovered' || submission?.status === 'already-recovered'
        ? 'already-recovered'
        : preparation.eligibility === 'not-ready'
          ? 'not-ready'
          : 'ready';
  return {
    schemaVersion: 1,
    kind: 'calledit-escrow-recovery',
    generatedAt: now.toISOString(),
    mode: submission === null ? (preparation.operation === 'inspect' ? 'inspect' : 'dry-run') : 'submitted',
    status,
    operation: preparation.operation,
    chain: {
      commitment: 'finalized',
      genesisHash: preparation.expectedGenesisHash,
      observedSlot: preparation.observedSlot.toString(),
      observedBlockTime: preparation.observedBlockTime.toString(),
    },
    deployment: {
      programId: preparation.programId.toBase58(),
      configPda: preparation.configPda.toBase58(),
      canonicalUsdcMint: preparation.canonicalUsdcMint.toBase58(),
    },
    market: {
      marketUuid: preparation.market.marketUuid,
      marketPda: preparation.marketPda.toBase58(),
      state: preparation.market.state,
      replay: preparation.market.replay,
      asset: preparation.market.asset,
      vault: preparation.market.vault,
      resolutionDeadline: preparation.market.resolutionDeadline.toString(),
    },
    position: {
      positionPda: preparation.positionPda.toBase58(),
      owner: preparation.owner.toBase58(),
      side: preparation.position.side,
      claimed: preparation.position.claimed,
      settlementProcessed: preparation.position.settlementProcessed,
      totalPaidAmountAtomic: preparation.position.totalPaidAmount.toString(),
    },
    recovery: {
      eligibility: preparation.eligibility,
      destination: preparation.destination.toBase58(),
      destinationKind: preparation.destinationKind,
      expectedAmountAtomic: preparation.expectedAmount?.toString() ?? null,
    },
    transaction: transaction === null || preparation.recentBlockhash === null || preparation.lastValidBlockHeight === null
      ? null
      : {
        instructionKinds: preparation.operation === 'timeout-refund'
          ? ['timeout_void', 'claim_position']
          : ['claim_position'],
        recentBlockhash: preparation.recentBlockhash,
        lastValidBlockHeight: preparation.lastValidBlockHeight.toString(),
        messageSha256: createHash('sha256').update(transaction.message.serialize()).digest('hex'),
        unsignedTransactionBase64: Buffer.from(transaction.serialize()).toString('base64'),
        estimatedFeeLamports: preparation.estimatedFeeLamports.toString(),
        requiredAtaRentLamports: preparation.requiredAtaRentLamports.toString(),
        ownerBalanceLamports: preparation.ownerBalanceLamports.toString(),
        feeBalanceSufficient: preparation.ownerBalanceLamports >= requiredFees,
      },
    submission: submission === null ? null : {
      status: submission.status,
      signature: submission.signature,
      finalizedSlot: submission.finalizedSlot?.toString() ?? null,
    },
  };
}

function parseIdentities(input: PrepareRecoveryInput): {
  readonly programId: PublicKey;
  readonly canonicalUsdcMint: PublicKey;
  readonly configPda: PublicKey;
  readonly marketPda: PublicKey;
  readonly positionPda: PublicKey;
  readonly owner: PublicKey;
} {
  const programId = publicKey(input.programId, 'program ID');
  const canonicalUsdcMint = publicKey(input.canonicalUsdcMint, 'canonical USDC mint');
  const owner = publicKey(input.owner, 'owner');
  let marketPda: PublicKey;
  try {
    marketPda = deriveMarketPda(programId, input.marketUuid).publicKey;
  } catch {
    fail('input_invalid', 'market UUID must use canonical UUID syntax');
  }
  return {
    programId,
    canonicalUsdcMint,
    owner,
    configPda: deriveProtocolConfigPda(programId).publicKey,
    marketPda,
    positionPda: deriveUserPositionPda(programId, marketPda, owner).publicKey,
  };
}

function publicKey(value: string, label: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    fail('input_invalid', `${label} must be a valid base58 public key`);
  }
}

function requiredAccount(snapshot: RecoveryAccountSnapshot, index: number, label: string): AccountInfo<Buffer> {
  const account = snapshot.accounts[index];
  if (account === undefined || account === null) fail('identity_mismatch', `${label} account is missing`);
  return account;
}

function decodeOwned<T>(
  account: AccountInfo<Buffer>,
  programId: PublicKey,
  decode: (bytes: Uint8Array) => T,
  label: string,
): T {
  try {
    assertEscrowAccountOwner(account.owner, programId);
    return decode(account.data);
  } catch {
    fail('program_mismatch', `${label} is not a valid account owned by the pinned escrow program`);
  }
}

function assertMarketAndOwnerBindings(input: {
  readonly programId: PublicKey;
  readonly canonicalUsdcMint: PublicKey;
  readonly marketPda: PublicKey;
  readonly positionPda: PublicKey;
  readonly owner: PublicKey;
  readonly marketUuid: string;
  readonly market: MarketAccount;
  readonly position: UserPositionAccount;
}): void {
  if (input.market.marketUuid !== input.marketUuid) fail('identity_mismatch', 'market account UUID does not match the requested market');
  if (input.position.market !== input.marketPda.toBase58() || input.position.owner !== input.owner.toBase58()) {
    fail('identity_mismatch', 'position account is not bound to the requested market and owner');
  }
  const expectedPosition = deriveUserPositionPda(input.programId, input.marketPda, input.owner).publicKey;
  if (!expectedPosition.equals(input.positionPda)) fail('identity_mismatch', 'owner position PDA is not canonical');
  const expectedMint = input.market.asset === 'usdc' ? input.canonicalUsdcMint.toBase58() : null;
  if (input.market.tokenMint !== expectedMint) fail('mint_mismatch', 'market asset mint does not match the pinned canonical mint');
  const expectedVault = input.market.asset === 'sol'
    ? deriveSolVaultPda(input.programId, input.marketPda).publicKey
    : deriveUsdcVaultAddress(input.marketPda, input.canonicalUsdcMint);
  if (input.market.vault !== expectedVault.toBase58()) fail('identity_mismatch', 'market vault is not the canonical asset vault');
}

function verifyAssetAccounts(input: {
  readonly snapshot: RecoveryAccountSnapshot;
  readonly market: MarketAccount;
  readonly marketPda: PublicKey;
  readonly programId: PublicKey;
  readonly canonicalUsdcMint: PublicKey;
  readonly destination: PublicKey;
  readonly owner: PublicKey;
}): boolean {
  const vaultInfo = requiredAccount(input.snapshot, 0, 'market vault');
  if (input.market.asset === 'sol') {
    if (!vaultInfo.owner.equals(input.programId) || vaultInfo.data.length !== 0) {
      fail('program_mismatch', 'SOL vault is not the canonical program-owned empty-data PDA');
    }
    return true;
  }
  const mintInfo = requiredAccount(input.snapshot, 1, 'canonical USDC mint');
  const destinationInfo = input.snapshot.accounts[2] ?? null;
  try {
    const mint = decodeClassicMint(mintInfo);
    const vault = decodeClassicTokenAccount(vaultInfo);
    if (!mint.initialized || mint.decimals !== 6) fail('mint_mismatch', 'canonical USDC mint must be initialized with six decimals');
    if (
      !vault.isInitialized || vault.isFrozen ||
      !vault.mint.equals(input.canonicalUsdcMint) ||
      !vault.owner.equals(input.marketPda)
    ) fail('mint_mismatch', 'USDC vault is not bound to the market and canonical mint');
    if (destinationInfo !== null) {
      const destination = decodeClassicTokenAccount(destinationInfo);
      if (
        !destination.isInitialized || destination.isFrozen ||
        !destination.mint.equals(input.canonicalUsdcMint) ||
        !destination.owner.equals(input.owner)
      ) fail('identity_mismatch', 'existing USDC destination is not the owner canonical associated token account');
    }
  } catch (cause) {
    if (cause instanceof RecoveryError) throw cause;
    fail('mint_mismatch', 'USDC mint, vault, or destination account failed classic SPL Token validation');
  }
  return destinationInfo !== null;
}

function decodeClassicMint(info: AccountInfo<Buffer>): { readonly initialized: boolean; readonly decimals: number } {
  if (!info.owner.equals(CLASSIC_TOKEN_PROGRAM_ID) || info.data.length !== 82) {
    fail('mint_mismatch', 'canonical USDC mint is not owned by the classic SPL Token program');
  }
  return { decimals: info.data[44] ?? -1, initialized: info.data[45] === 1 };
}

function decodeClassicTokenAccount(info: AccountInfo<Buffer>): {
  readonly isInitialized: boolean;
  readonly isFrozen: boolean;
  readonly mint: PublicKey;
  readonly owner: PublicKey;
} {
  if (!info.owner.equals(CLASSIC_TOKEN_PROGRAM_ID) || info.data.length !== 165) {
    fail('mint_mismatch', 'token account is not owned by the classic SPL Token program');
  }
  const state = info.data[108];
  return {
    mint: new PublicKey(info.data.subarray(0, 32)),
    owner: new PublicKey(info.data.subarray(32, 64)),
    isInitialized: state === 1,
    isFrozen: state === 2,
  };
}

function recoveryEligibility(
  market: MarketAccount,
  position: UserPositionAccount,
  blockTime: bigint,
): RecoveryEligibility {
  if (position.claimed) return 'already-recovered';
  if (market.state === 'settled' && position.settlementProcessed) return 'claim';
  if (market.state === 'voided') return 'refund';
  if ((market.state === 'open' || market.state === 'frozen') && blockTime >= market.resolutionDeadline) {
    return 'timeout-refund';
  }
  return 'not-ready';
}

function enforceOperation(operation: RecoveryOperation, eligibility: RecoveryEligibility): void {
  if (operation === 'inspect') return;
  if (eligibility === 'already-recovered') fail('already_recovered', 'owner position is already claimed');
  if (operation !== eligibility) fail('not_ready', `requested ${operation} is not available from finalized chain state`);
}

function recoverableAmount(
  market: MarketAccount,
  position: UserPositionAccount,
  eligibility: RecoveryEligibility,
): bigint | null {
  if (eligibility === 'refund' || eligibility === 'timeout-refund') return position.totalPaidAmount;
  if (eligibility !== 'claim') return null;
  const winningSide = market.settlementOutcome === 'claim_won'
    ? 'back'
    : market.settlementOutcome === 'claim_lost'
      ? 'doubt'
      : null;
  if (winningSide === null) fail('transaction_mismatch', 'settled market has no valid settlement outcome');
  if (position.side !== winningSide) return position.settlementBaseEntitlement;
  const totalWinning = winningSide === 'back' ? market.activeBackTotal : market.activeDoubtTotal;
  if (totalWinning === 0n) fail('transaction_mismatch', 'settled winning side has zero active principal');
  return position.settlementBaseEntitlement + ((position.activeAmount * market.finalForfeitedTotal) / totalWinning);
}

async function ownerPositionClaimed(rpc: RecoveryRpc, preparation: RecoveryPreparation): Promise<boolean> {
  const snapshot = await rpcCall(() => rpc.accounts([preparation.positionPda], preparation.observedSlot));
  const info = requiredAccount(snapshot, 0, 'owner position');
  const position = decodeOwned(info, preparation.programId, decodeUserPositionAccount, 'owner position');
  if (position.owner !== preparation.owner.toBase58() || position.market !== preparation.marketPda.toBase58()) {
    fail('identity_mismatch', 'finalized owner position binding changed');
  }
  return position.claimed;
}

async function rpcCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    if (cause instanceof RecoveryError) throw cause;
    fail('rpc_unavailable', 'finalized Solana RPC request failed');
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
