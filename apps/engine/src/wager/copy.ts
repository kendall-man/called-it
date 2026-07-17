/**
 * EVERY wager-mode user-facing string lives here and ONLY here — this is the
 * single module exempt from the vocabulary deny-list (stake/deposit/withdraw/
 * SOL are allowed). Nothing outside apps/engine/src/wager/ may import this
 * file (enforced by the seams slice's import-boundary test).
 *
 * Register: same game-show voice as bot/copy.ts, but real-stakes honest —
 * amounts are exact, "(devnet)" is stamped wherever value changes hands, and
 * nothing promises more than the mechanics deliver.
 */

import { formatSolAmount, shortPubkey } from './format.js';
import { WAGER_TUNABLES } from './constants.js';

export interface OrphanSweepNote {
  creditedCount: number;
  creditedLamports: bigint;
}

export const WAGER_COPY = {
  // ── stake gates & results ────────────────────────────────────────────────
  unlinkedOnboarding: (): string =>
    'This table plays for SOL. Link your wallet first (/wallet <address>), then /deposit to load your stack.',
  paused: (): string =>
    'The SOL desk is paused while we square the books. No new stakes for now; balances and cashouts are untouched.',
  insufficient: (balanceLamports: bigint): string =>
    `Not enough SOL on your stack. You're holding ${formatSolAmount(balanceLamports)}.`,
  pickALane: (): string => "You can't back it and doubt it. Pick a lane, your SOL agrees.",
  capReached: (capLamports: bigint): string =>
    `You're maxed on this call. ${formatSolAmount(capLamports)} is the ceiling per market.`,
  stakePlaced: (name: string, sideLabel: string, lamports: bigint, multiplier: string): string =>
    `${name} is in: ${sideLabel} with ${formatSolAmount(lamports)} at up to ×${multiplier}.`,
  stakeReplayed: (): string => "Already got that one. Your SOL's on it.",
  alreadyIn: (side: 'back' | 'doubt', lamports: bigint): string =>
    `Easy, you're already in: ${formatSolAmount(lamports)} ${side === 'back' ? 'backing' : 'against'} this call. One tap was all it took.`,
  staleTap: (): string => 'That ship has sailed.',

  // ── /wallet ──────────────────────────────────────────────────────────────
  walletUsage: (): string =>
    'Usage: /wallet <your wallet address>. Deposits from that address credit your stack. First to link an address keeps it, so link your own before someone funny does.',
  walletInvalid: (): string =>
    "That doesn't look like a wallet address. Paste the full base58 address from your wallet.",
  walletPubkeyTaken: (): string =>
    'That address is already claimed at this table, and first link wins. If that claim is wrong, get an admin to sort it.',
  walletLinked: (pubkey: string, sweep: OrphanSweepNote, relinked: boolean): string => {
    const lines = [`Wallet linked: ${shortPubkey(pubkey)}. SOL sent from it now credits your stack.`];
    if (sweep.creditedCount > 0) {
      lines.push(
        `Found ${sweep.creditedCount} earlier deposit${sweep.creditedCount === 1 ? '' : 's'} waiting: ${formatSolAmount(sweep.creditedLamports)} credited.`,
      );
    }
    if (relinked) {
      lines.push(
        'Heads up: this replaces your old link. Future sends from the old address will sit unclaimed.',
      );
    }
    return lines.join('\n');
  },
  walletStatus: (pubkey: string, balanceLamports: bigint): string =>
    `Linked wallet: ${shortPubkey(pubkey)}. Stack: ${formatSolAmount(balanceLamports)}.`,

  // ── /deposit ─────────────────────────────────────────────────────────────
  depositInstructions: (treasuryPubkey: string, linked: boolean): string => {
    const lines = [
      'Load your stack: send SOL to the table treasury:',
      treasuryPubkey,
      `Minimum ${formatSolAmount(WAGER_TUNABLES.MIN_DEPOSIT_LAMPORTS)}; smaller sends are ignored. Plain transfer from your linked wallet, no memo needed. It credits automatically within a minute or so.`,
      'Test tokens only. Do not send real mainnet SOL, it will not credit and cannot be returned.',
    ];
    if (!linked) {
      lines.push(
        'You have no wallet linked yet. /wallet <address> first; anything you sent before linking auto-credits the moment you link.',
      );
    }
    return lines.join('\n');
  },
  depositCredited: (name: string, lamports: bigint, balanceLamports: bigint): string =>
    `${name} just loaded ${formatSolAmount(lamports)} onto the stack. Balance: ${formatSolAmount(balanceLamports)}.`,

  // ── /withdraw ────────────────────────────────────────────────────────────
  withdrawUsage: (): string =>
    `Usage: /withdraw <amount|all> sends SOL back to your linked wallet. Minimum ${formatSolAmount(WAGER_TUNABLES.MIN_WITHDRAWAL_LAMPORTS)}.`,
  withdrawNoWallet: (): string =>
    'No wallet on file. /wallet <address> first, then /withdraw sends there.',
  withdrawBelowMin: (): string =>
    `Cashouts start at ${formatSolAmount(WAGER_TUNABLES.MIN_WITHDRAWAL_LAMPORTS)}. Build the stack a little first.`,
  withdrawInsufficient: (balanceLamports: bigint): string =>
    `Your stack is ${formatSolAmount(balanceLamports)}. Can't send more than that.`,
  withdrawQueued: (lamports: bigint): string =>
    `Cashout queued: ${formatSolAmount(lamports)} heading to your linked wallet. I'll post here when it lands.`,
  withdrawConfirmed: (name: string, lamports: bigint, explorerUrl: string): string =>
    `Cashout landed: ${formatSolAmount(lamports)} paid out to ${name}'s wallet. ${explorerUrl}`,
  withdrawFailed: (name: string, lamports: bigint): string =>
    `${name}'s cashout didn't make it onto the chain. ${formatSolAmount(lamports)} is back on the stack. Give it another go.`,

  // ── card & receipt furniture ─────────────────────────────────────────────
  cardFooter: (): string => '⚡ SOL on the line. The feed settles it at full time.',
  payoutsLineVoid: (): string => 'Call off. Every SOL stake returned.',
  payoutsLineNone: (): string => 'No SOL changed hands.',
  payoutPart: (name: string, lamports: bigint): string =>
    `${name} collects ${formatSolAmount(lamports)}`,
  payoutsLine: (parts: string[]): string => `${parts.join(' · ')}.`,

  // ── ops alerts (WAGER_OPS_CHAT_ID) ───────────────────────────────────────
  opsSolvencyAlert: (treasuryLamports: bigint, requiredLamports: bigint): string =>
    [
      'WAGER OPS: solvency breaker tripped. New stakes are paused.',
      `Treasury holds ${formatSolAmount(treasuryLamports)}; covering deposits, open stakes and the fee buffer needs ${formatSolAmount(requiredLamports)}.`,
      'Top the treasury up from a faucet. The breaker clears itself once covered.',
    ].join('\n'),
  opsSolvencyRecovered: (): string =>
    'WAGER OPS: treasury covers the book again. Breaker cleared, stakes are back on.',
} as const;

/** Human side label for stake acks. */
export function sideLabel(side: 'back' | 'doubt'): string {
  return side === 'back' ? 'Backing' : 'Doubting';
}
