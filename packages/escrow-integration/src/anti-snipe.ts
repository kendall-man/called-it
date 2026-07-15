import assert from 'node:assert/strict';
import {
  decodeMarketAccount,
  decodePositionLotAccount,
  decodeUserPositionAccount,
  materializeInstruction,
} from '@calledit/escrow-sdk';
import { evidenceHash, invalidationAttestation, thresholdInstructions } from './attestation-fixtures.js';
import { accountData, connection, expectTransactionFailure, sendInstructions } from './runtime.js';
import type { BootstrapContext, PlacedPosition } from './types.js';
import { decodeAnchorAccount } from './account-decode.js';

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
  await expectTransactionFailure('activation before anti-snipe delay', async () => sendInstructions({
    connection: rpc, feePayer: context.roles.relayer, instructions: [activate],
  }));

  const freeze = materializeInstruction({
    kind: 'freeze_market', feedOperatorAuthority: context.roles.feedAuthority.publicKey,
    marketUuid: placement.market.document.marketUuid, expectedEventEpoch: 0n,
    evidenceHash: evidenceHash('anti-snipe-freeze'),
  }, { programId: context.programId });
  await sendInstructions({
    connection: rpc, feePayer: context.roles.relayer,
    instructions: [freeze], signers: [context.roles.feedAuthority],
  });
  await expectTransactionFailure('activation after event epoch changed', async () => sendInstructions({
    connection: rpc, feePayer: context.roles.relayer, instructions: [activate],
  }));

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
  await expectTransactionFailure('duplicate lot invalidation', async () => sendInstructions({
    connection: rpc, feePayer: context.roles.relayer,
    instructions: [...thresholdInstructions(context, attestation.message), invalidate],
  }));
}
