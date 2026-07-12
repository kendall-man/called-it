/**
 * WagerModule assembly — the single object the engine seams talk to. wiring
 * constructs it (or leaves Deps.wager null when WAGER_MODE_ENABLED !== 'true'
 * or the treasury keypair is absent), and every seam short-circuits to exact
 * main behavior on null.
 */

import { WAGER_TUNABLES } from './constants.js';
import { WAGER_COPY } from './copy.js';
import { formatSolAmount, parseSolToLamports } from './format.js';
import { handleStakeTap } from './stake.js';
import { createDepositWatcher } from './deposits.js';
import { createWithdrawalExecutor } from './withdrawals.js';
import {
  applySettlement,
  createSettlementSweeper,
  settlementPayoutsLine,
} from './settlement.js';
import { createSolvencyMonitor } from './solvency.js';
import type {
  WagerBotLike,
  WagerCommandCtx,
  WagerCronRegistry,
  WagerModule,
  WagerModuleDeps,
} from './port.js';

// The contract lives in port.ts; re-exported here so seams that import from
// the module entry point (type-only) resolve without reaching into port.ts.
export type {
  WagerBotLike,
  WagerChain,
  WagerCommandCtx,
  WagerCronRegistry,
  WagerCurrency,
  WagerDb,
  WagerLogger,
  WagerMarketRow,
  WagerModule,
  WagerModuleDeps,
  WagerPoster,
  WagerSettlementOutcome,
  WagerStakeTapArgs,
  WagerStakeTapSource,
} from './port.js';

function commandArg(ctx: WagerCommandCtx): string {
  const match = ctx.match;
  if (typeof match === 'string') return match.trim();
  return (match?.[0] ?? '').trim();
}

function groupChatId(ctx: WagerCommandCtx): number | null {
  const chat = ctx.chat;
  if (!chat) return null;
  return chat.type === 'group' || chat.type === 'supergroup' ? chat.id : null;
}

export function createWagerModule(deps: WagerModuleDeps): WagerModule {
  const watcher = createDepositWatcher(deps);
  const executor = createWithdrawalExecutor(deps);
  const sweeper = createSettlementSweeper(deps);
  const solvency = createSolvencyMonitor(deps);

  /** Group commands double as notification-routing breadcrumbs. */
  async function rememberGroup(ctx: WagerCommandCtx, userId: number): Promise<void> {
    const groupId = groupChatId(ctx);
    if (groupId !== null) await deps.db.setLastWagerGroup(userId, groupId);
  }

  async function handleWalletCommand(ctx: WagerCommandCtx): Promise<void> {
    const from = ctx.from;
    if (!from) return;
    const arg = commandArg(ctx);
    if (arg === '') {
      const link = await deps.db.getWalletLink(from.id);
      if (link) {
        const balance = await deps.db.balanceLamports(from.id);
        await ctx.reply(WAGER_COPY.walletStatus(link.pubkey, balance));
      } else {
        await ctx.reply(WAGER_COPY.walletSetupUnavailable());
      }
      return;
    }
    await ctx.reply(WAGER_COPY.walletSetupUnavailable());
  }

  async function handleDepositCommand(ctx: WagerCommandCtx): Promise<void> {
    const from = ctx.from;
    if (!from) return;
    await rememberGroup(ctx, from.id);
    const link = await deps.db.getWalletLink(from.id);
    await ctx.reply(WAGER_COPY.depositInstructions(deps.chain.treasuryPubkey(), link !== null));
  }

  async function handleWithdrawCommand(ctx: WagerCommandCtx): Promise<void> {
    const from = ctx.from;
    if (!from) return;
    const link = await deps.db.getWalletLink(from.id);
    if (!link) {
      await ctx.reply(WAGER_COPY.withdrawNoWallet());
      return;
    }
    const arg = commandArg(ctx);
    if (arg === '') {
      await ctx.reply(WAGER_COPY.withdrawUsage());
      return;
    }
    const lamports =
      arg.toLowerCase() === 'all'
        ? await deps.db.balanceLamports(from.id)
        : parseSolToLamports(arg);
    if (lamports === null) {
      await ctx.reply(WAGER_COPY.withdrawUsage());
      return;
    }
    if (lamports < WAGER_TUNABLES.MIN_WITHDRAWAL_LAMPORTS) {
      await ctx.reply(WAGER_COPY.withdrawBelowMin());
      return;
    }
    const result = await deps.db.requestWithdrawal({ user_id: from.id, lamports });
    if (!result.ok) {
      if (result.code === 'no_wallet') {
        await ctx.reply(WAGER_COPY.withdrawNoWallet());
        return;
      }
      const balance = await deps.db.balanceLamports(from.id);
      await ctx.reply(WAGER_COPY.withdrawInsufficient(balance));
      return;
    }
    await rememberGroup(ctx, from.id);
    deps.log.info('wager_withdrawal_requested', {
      withdrawalId: result.withdrawal_id,
      lamports: lamports.toString(),
    });
    await ctx.reply(WAGER_COPY.withdrawQueued(lamports));
  }

  return {
    async currencyForMint() {
      // SOL-only product: every market is a SOL market.
      return 'sol';
    },

    handleStakeTap: (args) => handleStakeTap(deps, args),

    applySettlement: (marketId) => applySettlement(deps, marketId),

    settlementPayoutsLine: (marketId, outcome) => settlementPayoutsLine(deps, marketId, outcome),

    cardFooter: () => WAGER_COPY.cardFooter(),

    presetLabels() {
      const [first, second, third] = WAGER_TUNABLES.PRESET_STAKES_LAMPORTS;
      // Keyboard labels stay compact and exact ("0.05 SOL").
      return [formatSolAmount(first), formatSolAmount(second), formatSolAmount(third)];
    },

    presetLamports(index) {
      return WAGER_TUNABLES.PRESET_STAKES_LAMPORTS[index] ?? null;
    },

    async walletSummary(userId) {
      const [balanceLamports, link] = await Promise.all([
        deps.db.balanceLamports(userId),
        deps.db.getWalletLink(userId),
      ]);
      return { balanceLamports, pubkey: link?.pubkey ?? null };
    },

    registerCommands(bot: WagerBotLike) {
      bot.command('wallet', handleWalletCommand);
      bot.command('deposit', handleDepositCommand);
      bot.command('withdraw', handleWithdrawCommand);
    },

    registerCrons(registry: WagerCronRegistry) {
      registry.every(WAGER_TUNABLES.DEPOSIT_POLL_MS, () => watcher.tick());
      registry.every(WAGER_TUNABLES.OUTBOX_TICK_MS, () => executor.tick());
      registry.every(WAGER_TUNABLES.SETTLEMENT_SWEEP_MS, () => sweeper.tick());
      registry.every(WAGER_TUNABLES.SOLVENCY_POLL_MS, () => solvency.tick());
    },
  };
}
