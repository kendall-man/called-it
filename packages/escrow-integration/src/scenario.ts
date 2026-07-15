import assert from 'node:assert/strict';
import { getAccount, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { bootstrapEscrow } from './bootstrap.js';
import {
  proveSameOwnerPositionRules,
  proveSponsoredMessageIntegrity,
  proveOnChainSubstitutionRejection,
} from './adversarial.js';
import { proveAntiSnipe } from './anti-snipe.js';
import { MARKET_UUIDS, marketDocument, openMarket } from './markets.js';
import { fundUsdcUser, placeSponsoredPosition, usdcBalance } from './placements.js';
import { runReplayMarket } from './replay-phase.js';
import { proveSignatureRecovery } from './recovery-phase.js';
import { connection } from './runtime.js';
import { settleAndClaim } from './settlement-phase.js';
import { voidAndRefund } from './void-phase.js';
import type { ScenarioResult } from './types.js';

export async function runLocalValidatorScenario(): Promise<ScenarioResult> {
  const context = await bootstrapEscrow();
  const rpc = connection(context.rpcUrl);

  const settlementMarket = await openMarket(context, await marketDocument({
    context, marketUuid: MARKET_UUIDS.settlement, fixtureId: 10_001n,
    asset: 'sol', replay: false, timing: 'standard',
  }));
  const replayMarket = await openMarket(context, await marketDocument({
    context, marketUuid: MARKET_UUIDS.replay, fixtureId: 10_005n,
    asset: 'sol', replay: true, timing: 'standard',
  }));
  await proveSponsoredMessageIntegrity({ context, market: settlementMarket, owner: context.roles.users[0] });
  const backOwnerBefore = BigInt(await rpc.getBalance(context.roles.users[0].publicKey, 'finalized'));
  const back = await placeSponsoredPosition({
    context, market: settlementMarket, owner: context.roles.users[0], side: 'back', amount: 3_000_000n,
  });
  assert.equal(backOwnerBefore - BigInt(await rpc.getBalance(back.owner.publicKey, 'finalized')), back.amount);
  const doubt = await placeSponsoredPosition({
    context, market: settlementMarket, owner: context.roles.users[1], side: 'doubt', amount: 2_000_000n,
  });
  const reserve = BigInt(await rpc.getMinimumBalanceForRentExemption(0, 'finalized'));
  assert.equal(BigInt(await rpc.getBalance(settlementMarket.vault, 'finalized')) - reserve, back.amount + doubt.amount);
  await proveOnChainSubstitutionRejection({ context, placement: back, otherVault: replayMarket.vault });
  const additionalBack = await proveSameOwnerPositionRules({ context, placement: back });
  assert.equal(
    BigInt(await rpc.getBalance(settlementMarket.vault, 'finalized')) - reserve,
    back.amount + doubt.amount + additionalBack.amount,
  );
  await proveSignatureRecovery(context, back);
  await runReplayMarket({ context, market: replayMarket, liveBack: back, liveDoubt: doubt });

  const antiSnipeMarket = await openMarket(context, await marketDocument({
    context, marketUuid: MARKET_UUIDS.antiSnipe, fixtureId: 10_004n,
    asset: 'sol', replay: false, timing: 'in_play',
  }));
  const antiSnipe = await placeSponsoredPosition({
    context, market: antiSnipeMarket, owner: context.roles.users[2], side: 'back', amount: 1_000_000n,
  });
  await proveAntiSnipe(context, antiSnipe);

  const usdcMarket = await openMarket(context, await marketDocument({
    context, marketUuid: MARKET_UUIDS.usdcVoid, fixtureId: 10_002n,
    asset: 'usdc', replay: false, timing: 'standard',
  }));
  const usdcSource = await fundUsdcUser(context, context.roles.users[2].publicKey, 10_000_000n);
  const sourceBefore = await usdcBalance(context, usdcSource);
  const usdc = await placeSponsoredPosition({
    context, market: usdcMarket, owner: context.roles.users[2], side: 'doubt', amount: 5_000_000n,
  });
  assert.equal(sourceBefore - await usdcBalance(context, usdcSource), usdc.amount);
  assert.equal((await getAccount(rpc, usdcMarket.vault, 'finalized', TOKEN_PROGRAM_ID)).amount, usdc.amount);
  await proveOnChainSubstitutionRejection({ context, placement: usdc, otherVault: settlementMarket.vault });

  const replayUsdcMarket = await openMarket(context, await marketDocument({
    context, marketUuid: MARKET_UUIDS.replayUsdc, fixtureId: 10_006n,
    asset: 'usdc', replay: true, timing: 'standard',
  }));
  await fundUsdcUser(context, context.roles.users[0].publicKey, 2_000_000n);
  await fundUsdcUser(context, context.roles.users[1].publicKey, 2_000_000n);
  await runReplayMarket({ context, market: replayUsdcMarket, liveBack: back, liveDoubt: doubt });

  await settleAndClaim({
    context,
    market: settlementMarket,
    back,
    doubt,
    additionalLots: [additionalBack],
    outcome: 'claim_won',
  });

  const settlementLostMarket = await openMarket(context, await marketDocument({
    context, marketUuid: MARKET_UUIDS.settlementLost, fixtureId: 10_007n,
    asset: 'sol', replay: false, timing: 'standard',
  }));
  const lostBack = await placeSponsoredPosition({
    context, market: settlementLostMarket, owner: context.roles.users[0], side: 'back', amount: 2_000_000n,
  });
  const lostDoubt = await placeSponsoredPosition({
    context, market: settlementLostMarket, owner: context.roles.users[1], side: 'doubt', amount: 3_000_000n,
  });
  await settleAndClaim({
    context,
    market: settlementLostMarket,
    back: lostBack,
    doubt: lostDoubt,
    outcome: 'claim_lost',
  });

  const timeoutMarket = await openMarket(context, await marketDocument({
    context, marketUuid: MARKET_UUIDS.timeout, fixtureId: 10_003n,
    asset: 'sol', replay: false, timing: 'short_timeout',
  }));
  const timeoutSol = await placeSponsoredPosition({
    context, market: timeoutMarket, owner: context.roles.users[3], side: 'back', amount: 1_500_000n,
  });
  assert.equal(BigInt(await rpc.getBalance(timeoutMarket.vault, 'finalized')) - reserve, timeoutSol.amount);
  await voidAndRefund({ context, usdc, timeoutSol });

  return {
    bootstrap: true,
    placements: true,
    antiSnipe: true,
    settlement: true,
    voids: true,
    replayPath: true,
    recovery: true,
    closeGuards: true,
  };
}
