import {
  EscrowTransactionVerificationError,
  buildSponsoredPositionTransaction,
  derivePositionLotPda,
  deriveUserPositionPda,
  verifySponsoredPositionTransaction,
  verifySponsoredPositionTransactionBeforeUserSigning,
  type SponsoredPositionBuildOptions,
} from '@calledit/escrow-sdk';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Keypair, type PublicKey } from '@solana/web3.js';
import { chainTimestamp, connection, sendInstructions, submitSignedTransactionBytes } from './runtime.js';
import type { BootstrapContext, OpenedMarket, PlacedPosition } from './types.js';

export async function fundUsdcUser(context: BootstrapContext, owner: PublicKey, amount: bigint): Promise<PublicKey> {
  const rpc = connection(context.rpcUrl);
  const source = getAssociatedTokenAddressSync(context.canonicalUsdcMint, owner, false, TOKEN_PROGRAM_ID);
  const createSource = createAssociatedTokenAccountIdempotentInstruction(
    context.upgradeAuthority.publicKey, source, owner, context.canonicalUsdcMint, TOKEN_PROGRAM_ID,
  );
  const mint = createMintToInstruction(
    context.canonicalUsdcMint, source, context.roles.mintAuthority.publicKey, amount, [], TOKEN_PROGRAM_ID,
  );
  await sendInstructions({
    connection: rpc,
    feePayer: context.upgradeAuthority,
    instructions: [createSource, mint],
    signers: [context.roles.mintAuthority],
  });
  return source;
}

export function sponsoredTerms(input: {
  readonly context: BootstrapContext;
  readonly market: OpenedMarket;
  readonly owner: PublicKey;
  readonly side: 'back' | 'doubt';
  readonly amount: bigint;
  readonly nonce: bigint;
  readonly recentBlockhash: string;
  readonly lastValidBlockHeight: bigint;
  readonly expiresAt: bigint;
}): SponsoredPositionBuildOptions {
  return {
    programId: input.context.programId,
    relayerFeePayer: input.context.roles.relayer.publicKey,
    userWallet: input.owner,
    canonicalUsdcMint: input.context.canonicalUsdcMint,
    marketUuid: input.market.document.marketUuid,
    marketDocumentHash: input.market.documentHash,
    side: input.side,
    amount: input.amount,
    asset: input.market.document.asset,
    expectedRatioMilli: input.market.document.ratioMilli,
    expectedEventEpoch: 0n,
    expectedLotNonce: input.nonce,
    expiresAt: input.expiresAt,
    genesisHash: input.context.genesisHash,
    recentBlockhash: input.recentBlockhash,
    lastValidBlockHeight: input.lastValidBlockHeight,
  };
}

export async function placeSponsoredPosition(input: {
  readonly context: BootstrapContext;
  readonly market: OpenedMarket;
  readonly owner: Keypair;
  readonly side: 'back' | 'doubt';
  readonly amount: bigint;
  readonly nonce?: bigint;
}): Promise<PlacedPosition> {
  const rpc = connection(input.context.rpcUrl);
  const latest = await rpc.getLatestBlockhash('processed');
  const now = await chainTimestamp(rpc);
  const expiresAt = now + 120n < input.market.document.positionCutoff
    ? now + 120n
    : input.market.document.positionCutoff - 1n;
  const nonce = input.nonce ?? 0n;
  const terms = sponsoredTerms({
    context: input.context, market: input.market, owner: input.owner.publicKey,
    side: input.side, amount: input.amount, nonce,
    recentBlockhash: latest.blockhash, lastValidBlockHeight: BigInt(latest.lastValidBlockHeight), expiresAt,
  });
  const built = buildSponsoredPositionTransaction(terms);
  built.transaction.sign([input.context.roles.relayer]);
  const verification = {
    ...terms,
    expectedGenesisHash: input.context.genesisHash,
    observedGenesisHash: await rpc.getGenesisHash(),
    currentBlockHeight: BigInt(await rpc.getBlockHeight('confirmed')),
    currentUnixTimestamp: now,
  };
  await verifySponsoredPositionTransactionBeforeUserSigning(built.transaction, verification);
  built.transaction.sign([input.owner]);
  await verifySponsoredPositionTransaction(built.transaction, { ...verification, requireRelayerSignature: true });
  const signedBytes = built.transaction.serialize();
  const signature = await submitSignedTransactionBytes({
    connection: rpc,
    signedBytes,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  });
  const position = deriveUserPositionPda(input.context.programId, input.market.market, input.owner.publicKey).publicKey;
  const lot = derivePositionLotPda(input.context.programId, input.market.market, input.owner.publicKey, nonce).publicKey;
  return {
    owner: input.owner, market: input.market, position, lot, amount: input.amount,
    side: input.side, nonce, signature, lastValidBlockHeight: BigInt(latest.lastValidBlockHeight), signedBytes,
  };
}

export function isVerificationFailure(error: unknown): error is EscrowTransactionVerificationError {
  return error instanceof EscrowTransactionVerificationError;
}

export async function usdcBalance(context: BootstrapContext, account: PublicKey): Promise<bigint> {
  return (await getAccount(connection(context.rpcUrl), account, 'finalized', TOKEN_PROGRAM_ID)).amount;
}
