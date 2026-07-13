/**
 * WagerModule assembly — the single object the engine seams talk to. wiring
 * constructs a discriminated starter-only or funded runtime (or leaves
 * Deps.wager null when disabled).
 */

import { WAGER_TUNABLES } from './constants.js';
import { createHash, randomBytes } from 'node:crypto';
import { createWagerCopy } from './copy.js';
import { parseSolToLamports } from './format.js';
import { createDepositWatcher } from './deposits.js';
import { createWithdrawalExecutor } from './withdrawals.js';
import { createSolvencyMonitor } from './solvency.js';
import { createWagerModuleCore } from './module-core.js';
import type {
  WagerBotLike,
  WagerCommandCtx,
  WagerCronRegistry,
  FundedWagerModule,
  WagerModuleDeps,
} from './port.js';

const WALLET_LINK_SESSION_TTL_MS = 5 * 60_000;

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
  WagerModuleCore,
  WagerModuleDeps,
  WagerPoster,
  WagerSettlementOutcome,
  WagerStakeDeps,
  WagerStakeTapArgs,
  WagerStakeTapSource,
  FundedWagerModule,
  StarterOnlyWagerModule,
  StarterOnlyWagerModuleDeps,
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

export function createWagerModule(deps: WagerModuleDeps): FundedWagerModule {
  const copy = createWagerCopy(deps.solanaNetwork ?? 'devnet');
  const watcher = createDepositWatcher(deps);
  const executor = createWithdrawalExecutor(deps);
  const solvency = createSolvencyMonitor(deps);

  /** Group commands double as notification-routing breadcrumbs. */
  async function rememberGroup(ctx: WagerCommandCtx, userId: number): Promise<void> {
    const groupId = groupChatId(ctx);
    if (groupId !== null) await deps.db.setLastWagerGroup(userId, groupId);
  }

  async function handleWalletCommand(ctx: WagerCommandCtx): Promise<void> {
    const from = ctx.from;
    if (!from) return;
    if (ctx.chat?.type !== 'private') {
      await ctx.reply(copy.walletPrivateOnly());
      return;
    }
    const arg = commandArg(ctx);
    if (arg === '') {
      const link = await deps.db.getWalletLink(from.id);
      if (link) {
        const balance = await deps.db.balanceLamports(from.id);
        const status = copy.walletStatus(link.pubkey, balance);
        if (!(await replyWithWalletLink(ctx, from.id, status))) await ctx.reply(status);
        return;
      }
      if (!deps.walletMiniappEnabled || deps.webBaseUrl === undefined) {
        await ctx.reply(copy.walletSetupUnavailable());
        return;
      }
      if (!(await replyWithWalletLink(ctx, from.id, copy.walletSetupReady()))) {
        await ctx.reply(copy.walletSetupUnavailable());
      }
      return;
    }
    await ctx.reply(copy.walletSetupUnavailable());
  }

  async function replyWithWalletLink(
    ctx: WagerCommandCtx,
    userId: number,
    text: string,
  ): Promise<boolean> {
    if (!deps.walletMiniappEnabled || deps.webBaseUrl === undefined) return false;
    const token = randomBytes(32).toString('base64url');
    const session = await deps.db.createWalletLinkSession({
      user_id: userId,
      token_hash_hex: createHash('sha256').update(token).digest('hex'),
      expires_at: new Date(deps.now() + WALLET_LINK_SESSION_TTL_MS).toISOString(),
    });
    if (!session.ok) {
      deps.log.warn('wallet_link_session_refused', { code: session.code });
      return false;
    }
    const url = new URL('/wallet', deps.webBaseUrl);
    url.hash = new URLSearchParams({ token }).toString();
    await ctx.reply(text, {
      reply_markup: {
        inline_keyboard: [[{
          text: 'Create or manage wallet',
          web_app: { url: url.toString() },
        }]],
      },
    });
    return true;
  }

  async function handleDepositCommand(ctx: WagerCommandCtx): Promise<void> {
    const from = ctx.from;
    if (!from) return;
    await rememberGroup(ctx, from.id);
    const link = await deps.db.getWalletLink(from.id);
    await ctx.reply(copy.depositInstructions(deps.chain.treasuryPubkey(), link !== null));
  }

  async function handleWithdrawCommand(ctx: WagerCommandCtx): Promise<void> {
    const from = ctx.from;
    if (!from) return;
    const link = await deps.db.getWalletLink(from.id);
    if (!link) {
      await ctx.reply(copy.withdrawNoWallet());
      return;
    }
    const arg = commandArg(ctx);
    if (arg === '') {
      await ctx.reply(copy.withdrawUsage());
      return;
    }
    const lamports =
      arg.toLowerCase() === 'all'
        ? await deps.db.balanceLamports(from.id)
        : parseSolToLamports(arg);
    if (lamports === null) {
      await ctx.reply(copy.withdrawUsage());
      return;
    }
    if (lamports < WAGER_TUNABLES.MIN_WITHDRAWAL_LAMPORTS) {
      await ctx.reply(copy.withdrawBelowMin());
      return;
    }
    const result = await deps.db.requestWithdrawal({ user_id: from.id, lamports });
    if (!result.ok) {
      if (result.code === 'no_wallet') {
        await ctx.reply(copy.withdrawNoWallet());
        return;
      }
      const balance = await deps.db.balanceLamports(from.id);
      await ctx.reply(copy.withdrawInsufficient(balance));
      return;
    }
    await rememberGroup(ctx, from.id);
    deps.log.info('wager_withdrawal_requested', {
      withdrawalId: result.withdrawal_id,
      lamports: lamports.toString(),
    });
    await ctx.reply(copy.withdrawQueued(lamports));
  }

  return {
    kind: 'funded',
    ...createWagerModuleCore(deps),

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

    registerFundedWorkers(registry: WagerCronRegistry) {
      registry.every(WAGER_TUNABLES.DEPOSIT_POLL_MS, () => watcher.tick());
      registry.every(WAGER_TUNABLES.OUTBOX_TICK_MS, () => executor.tick());
      registry.every(WAGER_TUNABLES.SOLVENCY_POLL_MS, () => solvency.tick());
    },
  };
}
