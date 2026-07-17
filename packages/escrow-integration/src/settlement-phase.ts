import assert from 'node:assert/strict';
import {
  decodeMarketAccount,
  decodeUserPositionAccount,
  materializeInstruction,
  settlePositions,
} from '@calledit/escrow-sdk';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { settlementAttestation, thresholdInstructions } from './attestation-fixtures.js';
import {
  accountData,
  accountStateSnapshots,
  finalizedTransactionFee,
  connection,
  expectProgramError,
  expectTransactionFailure,
  sendInstructions,
} from './runtime.js';
import type { BootstrapContext, OpenedMarket, PlacedPosition } from './types.js';

function entitlementFor(
  settlement: ReturnType<typeof settlePositions>,
  placement: PlacedPosition,
): bigint {
  const payout = settlement.payouts.get(placement.owner.publicKey.toBase58()) ?? 0n;
  const refund = settlement.refunds
    .filter((item) => item.positionId === placement.position.toBase58())
    .reduce((total, item) => total + item.amount, 0n);
  return payout + refund;
}

async function ownerAssetBalance(
  context: BootstrapContext,
  market: OpenedMarket,
  placement: PlacedPosition,
): Promise<bigint> {
  const rpc = connection(context.rpcUrl);
  if (market.document.asset === 'sol') {
    return BigInt(await rpc.getBalance(placement.owner.publicKey, 'finalized'));
  }
  const ownerAta = getAssociatedTokenAddressSync(
    context.canonicalUsdcMint, placement.owner.publicKey, false, TOKEN_PROGRAM_ID,
  );
  return (await getAccount(rpc, ownerAta, 'finalized', TOKEN_PROGRAM_ID)).amount;
}

async function vaultPrincipal(context: BootstrapContext, market: OpenedMarket): Promise<bigint> {
  const rpc = connection(context.rpcUrl);
  if (market.document.asset === 'usdc') {
    return (await getAccount(rpc, market.vault, 'finalized', TOKEN_PROGRAM_ID)).amount;
  }
  const reserve = BigInt(await rpc.getMinimumBalanceForRentExemption(0, 'finalized'));
  return BigInt(await rpc.getBalance(market.vault, 'finalized')) - reserve;
}

export async function settleAndClaim(input: {
  readonly context: BootstrapContext;
  readonly market: OpenedMarket;
  readonly back: PlacedPosition;
  readonly doubt: PlacedPosition;
  readonly additionalLots?: readonly PlacedPosition[];
  readonly outcome?: 'claim_won' | 'claim_lost';
}): Promise<void> {
  const rpc = connection(input.context.rpcUrl);
  const outcome = input.outcome ?? 'claim_won';
  const placements = [input.back, input.doubt, ...(input.additionalLots ?? [])];
  for (const placement of placements) {
    assert(
      placement.position.equals(input.back.position) || placement.position.equals(input.doubt.position),
      'every additional lot must belong to one of the two aggregate positions',
    );
  }
  const aggregateAmount = (primary: PlacedPosition): bigint => placements
    .filter((placement) => placement.position.equals(primary.position))
    .reduce((total, placement) => total + placement.amount, 0n);
  const expected = settlePositions([
    { id: input.back.position.toBase58(), owner: input.back.owner.publicKey.toBase58(), side: input.back.side, activeAmount: aggregateAmount(input.back), pendingAmount: 0n, refundableAmount: 0n },
    { id: input.doubt.position.toBase58(), owner: input.doubt.owner.publicKey.toBase58(), side: input.doubt.side, activeAmount: aggregateAmount(input.doubt), pendingAmount: 0n, refundableAmount: 0n },
  ], outcome, BigInt(input.market.document.ratioMilli));
  const attestation = await settlementAttestation(input.context, input.market, outcome);
  const settle = materializeInstruction({
    kind: 'settle_market', marketUuid: input.market.document.marketUuid, attestation: attestation.value,
  }, { programId: input.context.programId });
  await sendInstructions({
    connection: rpc, feePayer: input.context.roles.relayer,
    instructions: [...thresholdInstructions(input.context, attestation.message), settle],
  });
  const settlementProtectedAccounts = [input.market.market, input.market.vault] as const;
  const beforeDuplicateSettlement = await accountStateSnapshots(rpc, settlementProtectedAccounts);
  await expectProgramError('duplicate settlement attestation', 6_046, async () => sendInstructions({
    connection: rpc, feePayer: input.context.roles.relayer,
    instructions: [...thresholdInstructions(input.context, attestation.message), settle],
  }));
  assert.deepEqual(await accountStateSnapshots(rpc, settlementProtectedAccounts), beforeDuplicateSettlement);

  for (const placement of [input.back, input.doubt]) {
    const calculate = materializeInstruction({
      kind: 'calculate_position_entitlement', marketUuid: input.market.document.marketUuid,
      owner: placement.owner.publicKey,
    }, { programId: input.context.programId });
    await sendInstructions({ connection: rpc, feePayer: input.context.roles.relayer, instructions: [calculate] });
  }
  const market = decodeMarketAccount(await accountData(rpc, input.market.market, input.context.programId));
  assert.equal(market.state, 'settled');
  assert.equal(
    market.finalForfeitedTotal,
    outcome === 'claim_won' ? expected.pots.matchedDoubt : expected.pots.matchedBack,
  );
  assert.equal(market.settlementProcessedPositionCount, 2n);

  const closeMarket = materializeInstruction({
    kind: 'close_market', marketUuid: input.market.document.marketUuid, asset: input.market.document.asset,
    canonicalUsdcMint: input.context.canonicalUsdcMint,
    residualRecipient: input.context.roles.residualRecipient.publicKey,
  }, { programId: input.context.programId });
  const closeBack = materializeInstruction({
    kind: 'close_position', marketUuid: input.market.document.marketUuid,
    owner: input.back.owner.publicKey, rentRecipient: input.context.roles.relayer.publicKey,
  }, { programId: input.context.programId });
  await expectTransactionFailure('market close with outstanding claims', async () => sendInstructions({
    connection: rpc, feePayer: input.context.roles.relayer, instructions: [closeMarket],
  }));
  await expectTransactionFailure('position close before claim', async () => sendInstructions({
    connection: rpc, feePayer: input.context.roles.relayer, instructions: [closeBack],
  }));

  const backExpected = entitlementFor(expected, input.back);
  const backBefore = await ownerAssetBalance(input.context, input.market, input.back);
  const doubtExpected = entitlementFor(expected, input.doubt);
  const doubtBefore = await ownerAssetBalance(input.context, input.market, input.doubt);
  const claimBack = materializeInstruction({
    kind: 'claim_position', marketUuid: input.market.document.marketUuid,
    owner: input.back.owner.publicKey, asset: input.market.document.asset,
    canonicalUsdcMint: input.context.canonicalUsdcMint,
  }, { programId: input.context.programId });
  const backSignature = await sendInstructions({
    connection: rpc, feePayer: input.back.owner, instructions: [claimBack],
  });
  const claimDoubt = materializeInstruction({
    kind: 'claim_position_for', payer: input.context.roles.relayer.publicKey,
    marketUuid: input.market.document.marketUuid, owner: input.doubt.owner.publicKey,
    asset: input.market.document.asset, canonicalUsdcMint: input.context.canonicalUsdcMint,
  }, { programId: input.context.programId });
  await sendInstructions({ connection: rpc, feePayer: input.context.roles.relayer, instructions: [claimDoubt] });
  const backAfter = await ownerAssetBalance(input.context, input.market, input.back);
  const doubtAfter = await ownerAssetBalance(input.context, input.market, input.doubt);
  const backFee = input.market.document.asset === 'sol' ? await finalizedTransactionFee(rpc, backSignature) : 0n;
  assert.equal(backAfter - backBefore + backFee, backExpected);
  assert.equal(doubtAfter - doubtBefore, doubtExpected);
  assert.equal(backExpected + doubtExpected + expected.dust, expected.totalDeposits);
  assert.equal(await vaultPrincipal(input.context, input.market), expected.dust);

  const backDestination = input.market.document.asset === 'sol'
    ? input.back.owner.publicKey
    : getAssociatedTokenAddressSync(
      input.context.canonicalUsdcMint,
      input.back.owner.publicKey,
      false,
      TOKEN_PROGRAM_ID,
    );
  const duplicateClaimProtectedAccounts = [
    input.market.market,
    input.back.position,
    input.market.vault,
    backDestination,
  ] as const;
  const beforeDuplicateClaim = await accountStateSnapshots(rpc, duplicateClaimProtectedAccounts);
  const duplicateClaim = materializeInstruction({
    kind: 'claim_position_for',
    payer: input.context.roles.relayer.publicKey,
    marketUuid: input.market.document.marketUuid,
    owner: input.back.owner.publicKey,
    asset: input.market.document.asset,
    canonicalUsdcMint: input.context.canonicalUsdcMint,
  }, { programId: input.context.programId });
  await expectProgramError('double claim', 6_056, async () => sendInstructions({
    connection: rpc,
    feePayer: input.context.roles.relayer,
    instructions: [duplicateClaim],
  }));
  assert.deepEqual(
    await accountStateSnapshots(rpc, duplicateClaimProtectedAccounts),
    beforeDuplicateClaim,
    'double-claim rejection must preserve market, position, vault, and owner destination',
  );

  await expectTransactionFailure('market close with open position accounts', async () => sendInstructions({
    connection: rpc, feePayer: input.context.roles.relayer, instructions: [closeMarket],
  }));
  for (const placement of [input.back, input.doubt]) {
    const lotNonces = placements
      .filter((candidate) => candidate.position.equals(placement.position))
      .map((candidate) => candidate.nonce)
      .sort((left, right) => left > right ? -1 : left < right ? 1 : 0);
    const closeLots = materializeInstruction({
      kind: 'close_position_lots', marketUuid: input.market.document.marketUuid,
      owner: placement.owner.publicKey, rentRecipient: input.context.roles.relayer.publicKey,
      lotNonces,
    }, { programId: input.context.programId });
    const closePosition = materializeInstruction({
      kind: 'close_position', marketUuid: input.market.document.marketUuid,
      owner: placement.owner.publicKey, rentRecipient: input.context.roles.relayer.publicKey,
    }, { programId: input.context.programId });
    await sendInstructions({ connection: rpc, feePayer: input.context.roles.relayer, instructions: [closeLots] });
    await sendInstructions({ connection: rpc, feePayer: input.context.roles.relayer, instructions: [closePosition] });
  }
  if (input.market.document.asset === 'usdc') {
    const residualAta = getAssociatedTokenAddressSync(
      input.context.canonicalUsdcMint, input.context.roles.residualRecipient.publicKey, false, TOKEN_PROGRAM_ID,
    );
    const createResidualAta = createAssociatedTokenAccountIdempotentInstruction(
      input.context.upgradeAuthority.publicKey, residualAta,
      input.context.roles.residualRecipient.publicKey, input.context.canonicalUsdcMint, TOKEN_PROGRAM_ID,
    );
    await sendInstructions({
      connection: rpc, feePayer: input.context.upgradeAuthority, instructions: [createResidualAta],
    });
  }
  await sendInstructions({ connection: rpc, feePayer: input.context.roles.relayer, instructions: [closeMarket] });
  assert.equal(await rpc.getAccountInfo(input.market.market, 'finalized'), null);
  assert.equal(await rpc.getAccountInfo(input.market.vault, 'finalized'), null);
  const positions = [input.back.position, input.doubt.position];
  for (const position of positions) assert.equal(await rpc.getAccountInfo(position, 'finalized'), null);
}
