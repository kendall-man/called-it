import { createHash } from 'node:crypto';
import type { SolanaNetwork } from '../solana-network.js';
import type { WagerBotLike, WagerCommandCtx } from '../wager/module.js';
import {
  escrowNetworkLabel,
  privateEscrowUrl,
  privateEscrowRecoveryUrl,
  type EscrowTelegramPort,
} from './escrow-ux.js';

export type EscrowAccountCommandContext = WagerCommandCtx;
export type EscrowAccountCommandBot = WagerBotLike;

export interface EscrowAccountCommandOptions {
  readonly webBaseUrl: string;
  readonly network: SolanaNetwork;
  readonly escrow: EscrowTelegramPort | undefined;
  readonly ensureUser: (user: {
    readonly id: number;
    readonly first_name: string;
    readonly last_name?: string;
    readonly username?: string;
  }) => Promise<void>;
  readonly now: () => number;
}

export function registerEscrowAccountCommands(
  bot: EscrowAccountCommandBot,
  options: EscrowAccountCommandOptions,
): void {
  bot.command('wallet', async (ctx) => {
    const from = ctx.from;
    if (from === undefined) return;
    if (ctx.chat?.type !== 'private') {
      await ctx.reply('For privacy, open my private chat and use /wallet there.');
      return;
    }
    if (options.escrow === undefined) {
      await ctx.reply('Secure wallet services are temporarily unavailable. Try /wallet again shortly.');
      return;
    }
    try {
      await options.ensureUser(from);
    } catch {
      await ctx.reply('Secure wallet services are temporarily unavailable. Try /wallet again shortly.');
      return;
    }
    const result = await options.escrow.createWalletSession({
      telegramUserId: from.id,
      idempotencyKey: createHash('sha256')
        .update(`telegram:escrow-wallet:${from.id}:${Math.floor(options.now() / 60_000)}`)
        .digest('hex'),
    });
    if (result.kind === 'rejected') {
      await ctx.reply('Secure wallet services are temporarily unavailable. Try /wallet again shortly.');
      return;
    }
    const walletUrl = privateEscrowUrl(options.webBaseUrl, 'wallet', result.token);
    const expiresAtMs = Date.parse(result.expiresAt);
    if (walletUrl === null || !Number.isFinite(expiresAtMs) || expiresAtMs <= options.now()) {
      await ctx.reply('That private wallet link expired. Run /wallet again.');
      return;
    }
    const legacyRecoveryUrl = privateEscrowRecoveryUrl(result.legacyRecoveryUrl);
    const rows: Array<Array<{ readonly text: string; readonly url: string }>> = [[{
      text: 'Open Privy wallet',
      url: walletUrl,
    }]];
    if (legacyRecoveryUrl !== null) {
      rows.push([{ text: 'Legacy balance recovery', url: legacyRecoveryUrl }]);
    }
    await ctx.reply([
      `Privy wallet · On-chain escrow · ${escrowNetworkLabel(options.network)}`,
      'Fund and manage your wallet directly. Called It does not hold new escrow balances.',
      legacyRecoveryUrl === null
        ? 'Any older Called It balance stays separate and withdrawable through legacy recovery.'
        : 'Any older Called It balance stays separate. Use Legacy balance recovery to withdraw it.',
    ].join('\n'), { reply_markup: { inline_keyboard: rows } });
  });
}
