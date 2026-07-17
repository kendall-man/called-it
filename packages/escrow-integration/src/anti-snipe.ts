import assert from 'node:assert/strict';
import {
  decodeMarketAccount,
  decodePositionLotAccount,
  decodeUserPositionAccount,
  materializeInstruction,
} from '@calledit/escrow-sdk';
import {
  evidenceHash,
  invalidationAttestation,
  thresholdInstructions,
  unfreezeAttestation,
} from './attestation-fixtures.js';
import {
  accountData,
  accountStateSnapshots,
  chainTimestamp,
  connection,
  expectProgramError,
  sendInstructions,
  waitUntil,
} from './runtime.js';
import type { BootstrapContext, PlacedPosition } from './types.js';
import { decodeAnchorAccount } from './account-decode.js';
import { placeSponsoredPosition } from './placements.js';

const PROGRAM_ERROR = {
  eventEpochMismatch: 6_036,
  invalidLotState: 6_038,
  activationDelayNotElapsed: 6_039,
} as const;

export async function proveAntiSnipe(context: BootstrapContext, placement: PlacedPosition): Promise<void> {
  const rpc = connection(context.rpcUrl);
  const originalLot = decodeAnchorAccount(
    await accountData(rpc, placement.lot, context.programId),
    decodePositionLotAccount,
  );
  const originalPosition = decodeUserPositionAccount(await accountData(rpc, placement.position, context.programId));
  assert.equal(originalLot.state, 'pending');
  assert.equal(originalLot.observedEventEpoch, 0n);
  assert.equal(originalPosition.pendingAmount, placement.amount);

  const activate = materializeInstruction({
    kind: 'activate_position_lot', marketUuid: placement.market.document.marketUuid,
    owner: placement.owner.publicKey, lotNonce: placement.nonce, expectedEventEpoch: 0n,
  }, { programId: context.programId });
  const protectedAccounts = [placement.market.market, placement.position, placement.lot, placement.market.vault] as const;
  const beforeEarlyActivation = await accountStateSnapshots(rpc, protectedAccounts);
  await expectProgramError('activation before anti-snipe delay', PROGRAM_ERROR.activationDelayNotElapsed, async () => sendInstructions({
    connection: rpc, feePayer: context.roles.relayer, instructions: [activate],
  }));
  assert.deepEqual(await accountStateSnapshots(rpc, protectedAccounts), beforeEarlyActivation);

  const freeze = materializeInstruction({
    kind: 'freeze_market', feedOperatorAuthority: context.roles.feedAuthority.publicKey,
    marketUuid: placement.market.document.marketUuid, expectedEventEpoch: 0n,
    evidenceHash: evidenceHash('anti-snipe-freeze'),
  }, { programId: context.programId });
  await sendInstructions({
    connection: rpc, feePayer: context.roles.relayer,
    instructions: [freeze], signers: [context.roles.feedAuthority],
  });
  const beforeStaleActivation = await accountStateSnapshots(rpc, protectedAccounts);
  await expectProgramError('activation after event epoch changed', PROGRAM_ERROR.eventEpochMismatch, async () => sendInstructions({
    connection: rpc, feePayer: context.roles.relayer, instructions: [activate],
  }));
  assert.deepEqual(await accountStateSnapshots(rpc, protectedAccounts), beforeStaleActivation);

  const attestation = await invalidationAttestation(context, placement);
  const invalidate = materializeInstruction({
    kind: 'invalidate_position_lot', marketUuid: placement.market.document.marketUuid,
    owner: placement.owner.publicKey, lotNonce: placement.nonce, attestation: attestation.value,
  }, { programId: context.programId });
  await sendInstructions({
    connection: rpc, feePayer: context.roles.relayer,
    instructions: [...thresholdInstructions(context, attestation.message), invalidate],
  });
  const invalidatedLot = decodeAnchorAccount(
    await accountData(rpc, placement.lot, context.programId),
    decodePositionLotAccount,
  );
  const refundablePosition = decodeUserPositionAccount(await accountData(rpc, placement.position, context.programId));
  const frozenMarket = decodeMarketAccount(await accountData(rpc, placement.market.market, context.programId));
  assert.equal(frozenMarket.state, 'frozen');
  assert.equal(frozenMarket.eventEpoch, 1n);
  assert.equal(invalidatedLot.state, 'voided');
  assert.equal(refundablePosition.pendingAmount, 0n);
  assert.equal(refundablePosition.refundableAmount, placement.amount);
  const beforeDuplicateInvalidation = await accountStateSnapshots(rpc, protectedAccounts);
  await expectProgramError('duplicate lot invalidation', PROGRAM_ERROR.invalidLotState, async () => sendInstructions({
    connection: rpc, feePayer: context.roles.relayer,
    instructions: [...thresholdInstructions(context, attestation.message), invalidate],
  }));
  assert.deepEqual(await accountStateSnapshots(rpc, protectedAccounts), beforeDuplicateInvalidation);

  const unfreezeAttested = await unfreezeAttestation(context, placement.market, 2n);
  const unfreeze = materializeInstruction({
    kind: 'unfreeze_market',
    marketUuid: placement.market.document.marketUuid,
    attestation: unfreezeAttested.value,
  }, { programId: context.programId });
  await sendInstructions({
    connection: rpc,
    feePayer: context.roles.relayer,
    instructions: [...thresholdInstructions(context, unfreezeAttested.message), unfreeze],
  });
  const reopenedMarket = decodeMarketAccount(await accountData(rpc, placement.market.market, context.programId));
  assert.equal(reopenedMarket.state, 'open');
  assert.equal(reopenedMarket.eventEpoch, 2n);

  const postUnfreeze = await placeSponsoredPosition({
    context,
    market: placement.market,
    owner: placement.owner,
    side: placement.side,
    amount: 1_000_000n,
    nonce: 1n,
    eventEpoch: 2n,
  });
  const pendingLot = decodeAnchorAccount(
    await accountData(rpc, postUnfreeze.lot, context.programId),
    decodePositionLotAccount,
  );
  assert.equal(pendingLot.state, 'pending');
  assert.notEqual(pendingLot.activationTimestamp, null);
  await waitUntil({
    operation: 'post-unfreeze lot activation delay',
    timeoutMs: 180_000,
    predicate: async () => await chainTimestamp(rpc) >= pendingLot.activationTimestamp!,
  });
  const activatePostUnfreeze = materializeInstruction({
    kind: 'activate_position_lot',
    marketUuid: placement.market.document.marketUuid,
    owner: postUnfreeze.owner.publicKey,
    lotNonce: postUnfreeze.nonce,
    expectedEventEpoch: 2n,
  }, { programId: context.programId });
  await sendInstructions({
    connection: rpc,
    feePayer: context.roles.relayer,
    instructions: [activatePostUnfreeze],
  });
  const activatedLot = decodeAnchorAccount(
    await accountData(rpc, postUnfreeze.lot, context.programId),
    decodePositionLotAccount,
  );
  const activatedPosition = decodeUserPositionAccount(await accountData(rpc, placement.position, context.programId));
  assert.equal(activatedLot.state, 'active');
  assert.equal(activatedPosition.pendingAmount, 0n);
  assert.equal(activatedPosition.activeAmount, postUnfreeze.amount);
  assert.equal(activatedPosition.refundableAmount, placement.amount);
}
