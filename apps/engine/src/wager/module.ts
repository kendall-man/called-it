/**
 * WagerModule assembly — the single object the engine seams talk to. wiring
 * constructs a discriminated starter-only or funded runtime (or leaves
 * Deps.wager null when disabled).
 */

import { WAGER_TUNABLES } from './constants.js';
import { createHash, randomBytes } from 'node:crypto';
import { createWagerCopy } from './copy.js';
import { assertSafeLamports, parseSolToLamports } from './format.js';
import { createDepositWatcher } from './deposits.js';
import { createWithdrawalExecutor } from './withdrawals.js';
import { createSolvencyMonitor } from './solvency.js';
import { createWagerModuleCore } from './module-core.js';
import { handleStakeTap } from './stake.js';
import type {
  WagerBotLike,
  WagerCommandCtx,
  WagerCronRegistry,
  FundedWagerModule,
  WagerModuleDeps,
} from './port.js';

const WALLET_LINK_SESSION_TTL_MS = 5 * 60_000;
const STAKE_CONFIRMATION_TTL_MS = 2 * 60_000;

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

  async function accountSummary(userId: number): Promise<{
    balanceLamports: bigint;
    lockedLamports: bigint;
    pubkey: string | null;
  }> {
    const [balanceLamports, link, marketIds] = await Promise.all([
      deps.db.balanceLamports(userId),
      deps.db.getWalletLink(userId),
      deps.db.openSolMarketIds(),
    ]);
    const marketPositions = await Promise.all(
      marketIds.map((marketId) => deps.db.positionsForMarket(marketId)),
    );
    let lockedLamports = 0n;
    for (const position of marketPositions.flat()) {
      if (position.user_id !== userId || position.state === 'void') continue;
      lockedLamports += assertSafeLamports(position.stake, `position ${position.id}`);
    }
    return { balanceLamports, lockedLamports, pubkey: link?.pubkey ?? null };
  }

  async function createConfirmation(
    args: import('./port.js').WagerStakeConfirmationArgs,
  ): Promise<import('./port.js').WagerStakeConfirmationResult> {
    if (!deps.stakeAcceptanceEnabled || (await deps.db.getWagerStatus()).paused) {
      return { ok: false, reply: copy.paused() };
    }
    const link = await deps.db.getWalletLink(args.userId);
    if (link === null) return { ok: false, reply: copy.unlinkedOnboarding() };
    const balance = await deps.db.balanceLamports(args.userId);
    if (balance < args.lamports) return { ok: false, reply: copy.insufficient(balance) };

    const input = {
      user_id: args.userId,
      group_id: args.market.group_id,
      market_id: args.market.id,
      side: args.side,
      lamports: args.lamports,
      intent_key_hash_hex: createHash('sha256')
        .update(`telegram:stake-confirmation:${args.callbackId}`)
        .digest('hex'),
      expires_at: new Date(deps.now() + STAKE_CONFIRMATION_TTL_MS).toISOString(),
    } as const;
    let created = await deps.db.createPendingStakeIntent(input);
    if (!created.ok && created.code === 'active_intent_exists') {
      const active = await deps.db.resolveActiveStakeIntent(args.userId);
      if (active.ok) await deps.db.cancelStakeIntent(args.userId, active.intent.id);
      created = await deps.db.createPendingStakeIntent(input);
    }
    if (!created.ok) return { ok: false, reply: copy.confirmationExpired() };
    if (created.state !== 'ready') {
      const ready = await deps.db.markStakeIntentFunded(args.userId, created.intent_id);
      if (!ready.ok) return { ok: false, reply: copy.confirmationExpired() };
    }
    return { ok: true, intentId: created.intent_id };
  }

  async function confirmStake(
    args: Omit<import('./port.js').WagerStakeConfirmationArgs, 'callbackId'> & {
      readonly intentId: string;
    },
  ): Promise<{ reply: string; placed: boolean }> {
    const active = await deps.db.resolveActiveStakeIntent(args.userId);
    if (
      !active.ok || active.intent.id !== args.intentId || active.intent.state !== 'ready'
      || active.intent.group_id !== args.market.group_id
      || active.intent.market_id !== args.market.id
      || active.intent.side !== args.side
      || active.intent.lamports !== args.lamports
    ) return { reply: copy.confirmationExpired(), placed: false };

    const result = await handleStakeTap(deps, {
      ...args,
      source: {
        kind: 'durable_source',
        idempotencyKey: `telegram:confirmed:${args.intentId}`,
      },
    });
    if (result.accepted === true) {
      await deps.db.consumeReadyStakeIntent(args.userId, args.intentId);
    } else {
      await deps.db.cancelStakeIntent(args.userId, args.intentId);
    }
    return { reply: result.reply, placed: result.placed };
  }

  async function getConfirmation(userId: number, intentId: string) {
    const active = await deps.db.resolveActiveStakeIntent(userId);
    if (!active.ok || active.intent.id !== intentId || active.intent.state !== 'ready') return null;
    return {
      marketId: active.intent.market_id,
      groupId: active.intent.group_id,
      side: active.intent.side,
      lamports: active.intent.lamports,
    };
  }

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
        const summary = await accountSummary(from.id);
        const status = copy.walletStatus(
          link.pubkey,
          summary.balanceLamports,
          summary.lockedLamports,
        );
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
    const url = new URL(`/wallet/${token}`, deps.webBaseUrl);
    await ctx.reply(text, {
      reply_markup: {
        inline_keyboard: [[{
          text: 'Create or manage wallet',
          url: url.toString(),
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

    walletSummary: accountSummary,

    prepareStakeConfirmation: createConfirmation,

    getStakeConfirmation: getConfirmation,

    confirmStakeConfirmation: confirmStake,

    async cancelStakeConfirmation(userId, intentId) {
      return (await deps.db.cancelStakeIntent(userId, intentId)).ok;
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
