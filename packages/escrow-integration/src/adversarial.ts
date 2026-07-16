import assert from 'node:assert/strict';
import {
  EscrowTransactionVerificationError,
  buildSponsoredPositionTransaction,
  decodePositionLotAccount,
  decodeUserPositionAccount,
  derivePositionLotPda,
  verifySponsoredPositionTransactionBeforeUserSigning,
  type SponsoredPositionBuildOptions,
} from '@calledit/escrow-sdk';
import { getAccount, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import {
  accountData,
  accountStateSnapshots,
  chainTimestamp,
  connection,
  expectProgramError,
  expectTransactionFailure,
  sendInstructions,
} from './runtime.js';
import { placeSponsoredPosition, sponsoredTerms } from './placements.js';
import type { BootstrapContext, OpenedMarket, PlacedPosition } from './types.js';
import { IntegrityAssertionError } from './errors.js';
import { decodeAnchorAccount } from './account-decode.js';

const PROGRAM_ERROR = {
  ratioMismatch: 6_014,
  assetMismatch: 6_016,
  oppositeSidePosition: 6_034,
  eventEpochMismatch: 6_036,
} as const;

async function expectVerificationFailure(
  operation: string,
  transaction: ReturnType<typeof buildSponsoredPositionTransaction>['transaction'],
  expected: SponsoredPositionBuildOptions,
  context: BootstrapContext,
  sponsor: Keypair = context.roles.relayer,
): Promise<void> {
  transaction.sign([sponsor]);
  const now = await chainTimestamp(connection(context.rpcUrl));
  try {
    await verifySponsoredPositionTransactionBeforeUserSigning(transaction, {
      ...expected,
      expectedGenesisHash: context.genesisHash,
      observedGenesisHash: context.genesisHash,
      currentBlockHeight: 0n,
      currentUnixTimestamp: now,
    });
  } catch (error) {
    if (error instanceof EscrowTransactionVerificationError) return;
    throw error;
  }
  throw new IntegrityAssertionError(`${operation} tampering passed sponsored-message verification`);
}

export async function proveSponsoredMessageIntegrity(input: {
  readonly context: BootstrapContext;
  readonly market: OpenedMarket;
  readonly owner: Keypair;
}): Promise<void> {
  const rpc = connection(input.context.rpcUrl);
  const latest = await rpc.getLatestBlockhash('finalized');
  const now = await chainTimestamp(rpc);
  const expected = sponsoredTerms({
    context: input.context, market: input.market, owner: input.owner.publicKey,
    side: 'back', amount: 3_000_000n, nonce: 0n, recentBlockhash: latest.blockhash,
    lastValidBlockHeight: BigInt(latest.lastValidBlockHeight), expiresAt: now + 100n,
  });
  const other = input.context.roles.users[1];
  const changes: readonly {
    readonly name: string;
    readonly terms: SponsoredPositionBuildOptions;
    readonly sponsor?: Keypair;
  }[] = [
    { name: 'owner', terms: { ...expected, userWallet: other.publicKey } },
    { name: 'side', terms: { ...expected, side: 'doubt' } },
    { name: 'amount', terms: { ...expected, amount: expected.amount + 1n } },
    { name: 'asset', terms: { ...expected, asset: 'usdc' } },
    { name: 'market', terms: { ...expected, marketUuid: '00000000-0000-4000-8000-000000000099' } },
    { name: 'nonce', terms: { ...expected, expectedLotNonce: 1n } },
    { name: 'expiry', terms: { ...expected, expiresAt: expected.expiresAt + 1n } },
    { name: 'program', terms: { ...expected, programId: SystemProgram.programId } },
    { name: 'relayer', terms: { ...expected, relayerFeePayer: other.publicKey }, sponsor: other },
  ];
  for (const change of changes) {
    await expectVerificationFailure(
      change.name,
      buildSponsoredPositionTransaction(change.terms).transaction,
      expected,
      input.context,
      change.sponsor,
    );
  }
  const expectedUsdc = { ...expected, asset: 'usdc' as const };
  const changedUsdcMint = { ...expectedUsdc, canonicalUsdcMint: Keypair.generate().publicKey };
  await expectVerificationFailure(
    'canonical USDC mint',
    buildSponsoredPositionTransaction(changedUsdcMint).transaction,
    expectedUsdc,
    input.context,
  );
  const correct = buildSponsoredPositionTransaction(expected).transaction;
  correct.sign([input.context.roles.relayer]);
  try {
    await verifySponsoredPositionTransactionBeforeUserSigning(correct, {
      ...expected,
      expectedGenesisHash: input.context.genesisHash,
      observedGenesisHash: Keypair.generate().publicKey.toBase58(),
      currentBlockHeight: 0n,
      currentUnixTimestamp: now,
    });
  } catch (error) {
    if (error instanceof EscrowTransactionVerificationError) return;
    throw error;
  }
  throw new IntegrityAssertionError('network substitution passed sponsored-message verification');
}

function replaceAccount(instruction: TransactionInstruction, index: number, replacement: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: instruction.programId,
    data: instruction.data,
    keys: instruction.keys.map((meta, metaIndex) => metaIndex === index ? { ...meta, pubkey: replacement } : meta),
  });
}

export async function proveOnChainSubstitutionRejection(input: {
  readonly context: BootstrapContext;
  readonly placement: PlacedPosition;
  readonly otherVault: PublicKey;
}): Promise<void> {
  const rpc = connection(input.context.rpcUrl);
  const latest = await rpc.getLatestBlockhash('finalized');
  const now = await chainTimestamp(rpc);
  const terms = sponsoredTerms({
    context: input.context, market: input.placement.market, owner: input.placement.owner.publicKey,
    side: input.placement.side, amount: 1_000_000n, nonce: 1n,
    recentBlockhash: latest.blockhash, lastValidBlockHeight: BigInt(latest.lastValidBlockHeight), expiresAt: now + 100n,
  });
  const instruction = buildSponsoredPositionTransaction(terms).instruction;
  const vaultBalance = async (): Promise<bigint> => input.placement.market.document.asset === 'usdc'
    ? (await getAccount(rpc, input.placement.market.vault, 'finalized', TOKEN_PROGRAM_ID)).amount
    : BigInt(await rpc.getBalance(input.placement.market.vault, 'finalized'));
  const vaultBefore = await vaultBalance();
  const nextLot = derivePositionLotPda(
    input.context.programId,
    input.placement.market.market,
    input.placement.owner.publicKey,
    1n,
  ).publicKey;
  const protectedAccounts = [
    input.placement.market.market,
    input.placement.position,
    nextLot,
    input.placement.market.vault,
    input.placement.owner.publicKey,
  ] as const;
  const semanticAttempts = [
    {
      name: 'wrong asset substitution',
      code: PROGRAM_ERROR.assetMismatch,
      instruction: buildSponsoredPositionTransaction({
        ...terms,
        asset: input.placement.market.document.asset === 'sol' ? 'usdc' : 'sol',
      }).instruction,
    },
    {
      name: 'wrong ratio substitution',
      code: PROGRAM_ERROR.ratioMismatch,
      instruction: buildSponsoredPositionTransaction({
        ...terms,
        expectedRatioMilli: terms.expectedRatioMilli + 1,
      }).instruction,
    },
    {
      name: 'wrong event epoch substitution',
      code: PROGRAM_ERROR.eventEpochMismatch,
      instruction: buildSponsoredPositionTransaction({
        ...terms,
        expectedEventEpoch: terms.expectedEventEpoch + 1n,
      }).instruction,
    },
  ] as const;
  for (const attempt of semanticAttempts) {
    const before = await accountStateSnapshots(rpc, protectedAccounts);
    await expectProgramError(attempt.name, attempt.code, async () => sendInstructions({
      connection: rpc,
      feePayer: input.context.roles.relayer,
      instructions: [attempt.instruction],
      signers: [input.placement.owner],
    }));
    assert.deepEqual(
      await accountStateSnapshots(rpc, protectedAccounts),
      before,
      `${attempt.name} must not change owner, position, lot, market, or vault state`,
    );
  }
  const commonAttempts = [
    { name: 'market account substitution', instruction: replaceAccount(instruction, 1, SystemProgram.programId), signer: input.placement.owner },
    { name: 'owner account substitution', instruction: replaceAccount(instruction, 3, input.context.roles.users[3].publicKey), signer: input.context.roles.users[3] },
    { name: 'vault account substitution', instruction: replaceAccount(instruction, 6, input.otherVault), signer: input.placement.owner },
    { name: 'token program substitution', instruction: replaceAccount(instruction, 9, SystemProgram.programId), signer: input.placement.owner },
    { name: 'program substitution', instruction: new TransactionInstruction({ ...instruction, programId: SystemProgram.programId }), signer: input.placement.owner },
  ] as const;
  const usdcAttempts = input.placement.market.document.asset === 'usdc' ? [
    { name: 'source account substitution', instruction: replaceAccount(instruction, 7, input.context.roles.users[3].publicKey), signer: input.placement.owner },
    { name: 'mint account substitution', instruction: replaceAccount(instruction, 8, SystemProgram.programId), signer: input.placement.owner },
  ] as const : [];
  const attempts = [...commonAttempts, ...usdcAttempts];
  for (const attempt of attempts) {
    await expectTransactionFailure(attempt.name, async () => sendInstructions({
      connection: rpc, feePayer: input.context.roles.relayer,
      instructions: [attempt.instruction], signers: [attempt.signer],
    }));
  }
  const duplicate = buildSponsoredPositionTransaction({ ...terms, expectedLotNonce: 0n }).instruction;
  await expectTransactionFailure('duplicate lot nonce', async () => sendInstructions({
    connection: rpc, feePayer: input.context.roles.relayer,
    instructions: [duplicate], signers: [input.placement.owner],
  }));
  assert.equal(await vaultBalance(), vaultBefore, 'rejected substitutions must not move principal');
}

export async function proveSameOwnerPositionRules(input: {
  readonly context: BootstrapContext;
  readonly placement: PlacedPosition;
}): Promise<PlacedPosition> {
  const rpc = connection(input.context.rpcUrl);
  const additional = await placeSponsoredPosition({
    context: input.context,
    market: input.placement.market,
    owner: input.placement.owner,
    side: input.placement.side,
    amount: 1_000_000n,
    nonce: 1n,
  });
  const aggregate = decodeUserPositionAccount(await accountData(
    rpc,
    input.placement.position,
    input.context.programId,
  ));
  const lot = decodeAnchorAccount(
    await accountData(rpc, additional.lot, input.context.programId),
    decodePositionLotAccount,
  );
  assert.equal(aggregate.side, input.placement.side);
  assert.equal(aggregate.activeAmount, input.placement.amount + additional.amount);
  assert.equal(aggregate.nextLotNonce, 2n);
  assert.equal(lot.state, 'active');

  const rejectedLot = derivePositionLotPda(
    input.context.programId,
    input.placement.market.market,
    input.placement.owner.publicKey,
    2n,
  ).publicKey;
  const protectedAccounts = [
    input.placement.market.market,
    input.placement.position,
    rejectedLot,
    input.placement.market.vault,
    input.placement.owner.publicKey,
  ] as const;
  const before = await accountStateSnapshots(rpc, protectedAccounts);
  await expectProgramError('same owner opposite-side placement', PROGRAM_ERROR.oppositeSidePosition, async () => {
    await placeSponsoredPosition({
      context: input.context,
      market: input.placement.market,
      owner: input.placement.owner,
      side: input.placement.side === 'back' ? 'doubt' : 'back',
      amount: 1_000_000n,
      nonce: 2n,
    });
  });
  assert.deepEqual(
    await accountStateSnapshots(rpc, protectedAccounts),
    before,
    'opposite-side rejection must not change owner, position, lot, market, or vault state',
  );
  return additional;
}
