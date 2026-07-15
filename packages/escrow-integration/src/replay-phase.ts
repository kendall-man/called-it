import assert from 'node:assert/strict';
import { getAccount, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { connection, expectTransactionFailure } from './runtime.js';
import { placeSponsoredPosition } from './placements.js';
import { settleAndClaim } from './settlement-phase.js';
import type { BootstrapContext, OpenedMarket, PlacedPosition } from './types.js';

async function assertNoPointsEffects(context: BootstrapContext, market: OpenedMarket): Promise<void> {
  const rpc = connection(context.rpcUrl);
  const signatures = await rpc.getSignaturesForAddress(market.market, { limit: 100 }, 'finalized');
  assert(signatures.length > 0, 'replay market must have finalized transaction history');
  for (const item of signatures) {
    const transaction = await rpc.getTransaction(item.signature, {
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
    });
    const logs = transaction?.meta?.logMessages ?? [];
    assert.equal(logs.some((line) => /points/i.test(line)), false, 'replay transactions must not emit Points effects');
  }
}

async function replayVaultBalance(context: BootstrapContext, market: OpenedMarket): Promise<bigint> {
  const rpc = connection(context.rpcUrl);
  return market.document.asset === 'usdc'
    ? (await getAccount(rpc, market.vault, 'finalized', TOKEN_PROGRAM_ID)).amount
    : BigInt(await rpc.getBalance(market.vault, 'finalized'));
}

export async function runReplayMarket(input: {
  readonly context: BootstrapContext;
  readonly market: OpenedMarket;
  readonly liveBack: PlacedPosition;
  readonly liveDoubt: PlacedPosition;
}): Promise<void> {
  const rpc = connection(input.context.rpcUrl);
  const replayBack = await placeSponsoredPosition({
    context: input.context, market: input.market,
    owner: input.liveBack.owner, side: 'back', amount: 1_000_000n,
  });
  const replaySecond = await placeSponsoredPosition({
    context: input.context, market: input.market,
    owner: input.liveDoubt.owner, side: 'back', amount: 1_000_000n,
  });
  assert.notEqual(replayBack.market.market.toBase58(), input.liveBack.market.market.toBase58());
  assert.notEqual(replayBack.market.vault.toBase58(), input.liveBack.market.vault.toBase58());
  assert.notEqual(replayBack.position.toBase58(), input.liveBack.position.toBase58());
  assert.notEqual(replayBack.lot.toBase58(), input.liveBack.lot.toBase58());
  assert.equal(replayBack.market.document.replayFlag, true);
  const vaultBeforeCapAttempt = await replayVaultBalance(input.context, input.market);
  await expectTransactionFailure('replay per-user position cap', async () => placeSponsoredPosition({
    context: input.context, market: input.market,
    owner: replayBack.owner, side: 'back', amount: 100_000_000n, nonce: 1n,
  }));
  assert.equal(await replayVaultBalance(input.context, input.market), vaultBeforeCapAttempt);
  await settleAndClaim({
    context: input.context,
    market: input.market,
    back: replayBack,
    doubt: replaySecond,
  });
  await assertNoPointsEffects(input.context, input.market);
}
