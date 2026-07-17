import assert from 'node:assert/strict';
import {
  decodeMarketAccount,
  decodeProtocolConfigAccount,
  decodeUserPositionAccount,
  deriveProtocolConfigPda,
  materializeInstruction,
} from '@calledit/escrow-sdk';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { thresholdInstructions, voidAttestation } from './attestation-fixtures.js';
import {
  accountData,
  chainTimestamp,
  finalizedTransactionFee,
  connection,
  sendInstructions,
  waitUntil,
} from './runtime.js';
import { usdcBalance } from './placements.js';
import type { BootstrapContext, PlacedPosition } from './types.js';

export async function voidAndRefund(input: {
  readonly context: BootstrapContext;
  readonly usdc: PlacedPosition;
  readonly timeoutSol: PlacedPosition;
}): Promise<void> {
  const rpc = connection(input.context.rpcUrl);
  const ownerAta = getAssociatedTokenAddressSync(
    input.context.canonicalUsdcMint, input.usdc.owner.publicKey, false, TOKEN_PROGRAM_ID,
  );
  const beforeUsdc = await usdcBalance(input.context, ownerAta);
  const beforeSol = BigInt(await rpc.getBalance(input.timeoutSol.owner.publicKey, 'finalized'));
  const pause = materializeInstruction({
    kind: 'set_pause', authority: input.context.roles.pauseAuthority.publicKey, paused: true,
  }, { programId: input.context.programId });
  await sendInstructions({
    connection: rpc, feePayer: input.context.roles.relayer,
    instructions: [pause], signers: [input.context.roles.pauseAuthority],
  });
  const config = decodeProtocolConfigAccount(await accountData(
    rpc, deriveProtocolConfigPda(input.context.programId).publicKey, input.context.programId,
  ));
  assert.equal(config.paused, true);

  const signed = await voidAttestation(input.context, input.usdc.market);
  const voidMarket = materializeInstruction({
    kind: 'void_market', marketUuid: input.usdc.market.document.marketUuid, attestation: signed.value,
  }, { programId: input.context.programId });
  await sendInstructions({
    connection: rpc, feePayer: input.context.roles.relayer,
    instructions: [...thresholdInstructions(input.context, signed.message), voidMarket],
  });
  const claimUsdc = materializeInstruction({
    kind: 'claim_position_for', payer: input.context.roles.relayer.publicKey,
    marketUuid: input.usdc.market.document.marketUuid, owner: input.usdc.owner.publicKey,
    asset: 'usdc', canonicalUsdcMint: input.context.canonicalUsdcMint,
  }, { programId: input.context.programId });
  await sendInstructions({ connection: rpc, feePayer: input.context.roles.relayer, instructions: [claimUsdc] });
  assert.equal(await usdcBalance(input.context, ownerAta) - beforeUsdc, input.usdc.amount);
  const voidedUsdc = decodeMarketAccount(await accountData(rpc, input.usdc.market.market, input.context.programId));
  assert.equal(voidedUsdc.state, 'voided');
  const usdcPosition = decodeUserPositionAccount(await accountData(rpc, input.usdc.position, input.context.programId));
  assert.equal(usdcPosition.claimed, true);

  await waitUntil({
    operation: 'timeout resolution deadline', timeoutMs: 40_000,
    predicate: async () => await chainTimestamp(rpc) >= input.timeoutSol.market.document.resolutionDeadline,
  });
  const timeoutVoid = materializeInstruction({
    kind: 'timeout_void', marketUuid: input.timeoutSol.market.document.marketUuid,
  }, { programId: input.context.programId });
  await sendInstructions({ connection: rpc, feePayer: input.context.roles.relayer, instructions: [timeoutVoid] });
  const timeoutMarket = decodeMarketAccount(await accountData(rpc, input.timeoutSol.market.market, input.context.programId));
  assert.equal(timeoutMarket.state, 'voided');
  const claimSol = materializeInstruction({
    kind: 'claim_position', marketUuid: input.timeoutSol.market.document.marketUuid,
    owner: input.timeoutSol.owner.publicKey, asset: 'sol', canonicalUsdcMint: input.context.canonicalUsdcMint,
  }, { programId: input.context.programId });
  const signature = await sendInstructions({ connection: rpc, feePayer: input.timeoutSol.owner, instructions: [claimSol] });
  const afterSol = BigInt(await rpc.getBalance(input.timeoutSol.owner.publicKey, 'finalized'));
  assert.equal(afterSol - beforeSol + await finalizedTransactionFee(rpc, signature), input.timeoutSol.amount);
  const configAfterRecovery = decodeProtocolConfigAccount(await accountData(
    rpc, deriveProtocolConfigPda(input.context.programId).publicKey, input.context.programId,
  ));
  assert.equal(configAfterRecovery.paused, true, 'recovery must remain available without unpausing intake');
}
