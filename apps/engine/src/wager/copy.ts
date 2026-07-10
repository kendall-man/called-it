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
    'This table uses test SOL on Solana devnet. It has no monetary value. Open /wallet in private chat to verify a devnet wallet before placing a position.',
  paused: (): string =>
    'New SOL positions are paused while account coverage is checked. Existing balances and withdrawal requests are unchanged.',
  insufficient: (balanceLamports: bigint): string =>
    `Not enough test SOL for that position. Available balance: ${formatSolAmount(balanceLamports)} (devnet). Use /deposit to add test SOL.`,
  pickALane: (): string => "You can't back it and doubt it — pick a lane. Your SOL agrees.",
  capReached: (capLamports: bigint): string =>
    `You're maxed on this call — ${formatSolAmount(capLamports)} is the ceiling per market.`,
  stakePlaced: (name: string, sideLabel: string, lamports: bigint, multiplier: string): string =>
    `${name}'s position is recorded — ${sideLabel} with ${formatSolAmount(lamports)} at up to ×${multiplier}. Test SOL is a devnet token with no monetary value.`,
  stakeReplayed: (): string => "Already got that one — your SOL's on it.",
  staleTap: (): string => 'That ship has sailed.',

  // ── /wallet ──────────────────────────────────────────────────────────────
  walletUsage: (): string =>
    'Open /wallet in private chat to verify the Solana devnet wallet for your account.',
  walletInvalid: (): string =>
    "That doesn't look like a wallet address — paste the full base58 address from your devnet wallet.",
  walletPubkeyTaken: (): string =>
    'That wallet cannot be verified for this account. No account state changed. Open /me to review your wallet status.',
  walletLinked: (pubkey: string, sweep: OrphanSweepNote, relinked: boolean): string => {
    const lines = [`Wallet linked: ${shortPubkey(pubkey)}. Eligible devnet transfers from it can credit your account.`];
    if (sweep.creditedCount > 0) {
      lines.push(
        `Found ${sweep.creditedCount} earlier deposit${sweep.creditedCount === 1 ? '' : 's'} waiting — ${formatSolAmount(sweep.creditedLamports)} credited. (devnet)`,
      );
    }
    if (relinked) {
      lines.push(
        'Heads up: this replaces your old link — future sends from the old address will sit unclaimed.',
      );
    }
    return lines.join('\n');
  },
  walletStatus: (pubkey: string, balanceLamports: bigint): string =>
    `Linked wallet: ${shortPubkey(pubkey)}. Available balance: ${formatSolAmount(balanceLamports)} (devnet). Use /deposit to add test SOL or /withdraw to return it.`,

  // ── /deposit ─────────────────────────────────────────────────────────────
  depositInstructions: (treasuryPubkey: string, linked: boolean): string => {
    const lines = [
      'Add test SOL by sending a devnet transfer to the table treasury —',
      treasuryPubkey,
      `Minimum ${formatSolAmount(WAGER_TUNABLES.MIN_DEPOSIT_LAMPORTS)}; smaller sends are ignored. Plain transfer from your linked wallet, no memo needed — it credits automatically within a minute or so.`,
      'DEVNET ONLY. Test SOL has no monetary value. Do not send mainnet SOL; it will not credit and cannot be returned.',
    ];
    if (!linked) {
      lines.push(
        'No verified wallet is linked. Open /wallet in private chat first; transfers remain pending until verification completes.',
      );
    }
    return lines.join('\n');
  },
  depositCredited: (name: string, lamports: bigint, balanceLamports: bigint): string =>
    `${name}'s deposit was recorded: ${formatSolAmount(lamports)}. Available balance: ${formatSolAmount(balanceLamports)}. (devnet)`,

  // ── /withdraw ────────────────────────────────────────────────────────────
  withdrawUsage: (): string =>
    `Usage: /withdraw <amount|all> — sends devnet SOL back to your linked wallet. Minimum ${formatSolAmount(WAGER_TUNABLES.MIN_WITHDRAWAL_LAMPORTS)}.`,
  withdrawNoWallet: (): string =>
    'No verified wallet is available. No SOL moved. Open /wallet in private chat first.',
  withdrawBelowMin: (): string =>
    `Withdrawals start at ${formatSolAmount(WAGER_TUNABLES.MIN_WITHDRAWAL_LAMPORTS)}. No SOL moved. Choose a qualifying amount.`,
  withdrawInsufficient: (balanceLamports: bigint): string =>
    `Available balance: ${formatSolAmount(balanceLamports)} (devnet). No SOL moved. Choose a smaller amount.`,
  withdrawQueued: (lamports: bigint): string =>
    `Withdrawal queued: ${formatSolAmount(lamports)} to your verified wallet. I'll post the receipt when it confirms. (devnet)`,
  withdrawConfirmed: (name: string, lamports: bigint, explorerUrl: string): string =>
    `Withdrawal confirmed: ${formatSolAmount(lamports)} sent to ${name}'s verified wallet. Receipt: ${explorerUrl} (devnet)`,
  withdrawFailed: (name: string, lamports: bigint): string =>
    `${name}'s withdrawal was not submitted. ${formatSolAmount(lamports)} is available again. No SOL left the account. Open /me before trying again.`,

  // ── card & receipt furniture ─────────────────────────────────────────────
  cardFooter: (): string =>
    'Test SOL is a devnet token with no monetary value. Use /me for account status.',
  payoutsLineVoid: (): string => 'Call off — every SOL stake returned. (devnet)',
  payoutsLineNone: (): string => 'No SOL changed hands. (devnet)',
  payoutPart: (name: string, lamports: bigint): string =>
    `${name} collects ${formatSolAmount(lamports)}`,
  payoutsLine: (parts: string[]): string => `${parts.join(' · ')}. (devnet)`,

  // ── ops alerts (WAGER_OPS_CHAT_ID) ───────────────────────────────────────
  opsSolvencyAlert: (treasuryLamports: bigint, requiredLamports: bigint): string =>
    [
      'WAGER OPS — solvency breaker tripped. New stakes are paused.',
      `Treasury holds ${formatSolAmount(treasuryLamports)}; covering deposits, open stakes and the fee buffer needs ${formatSolAmount(requiredLamports)}.`,
      'Top the devnet treasury up from a faucet — the breaker clears itself once covered.',
    ].join('\n'),
  opsSolvencyRecovered: (): string =>
    'WAGER OPS — treasury covers the book again. Breaker cleared, stakes are back on.',
} as const;

/** Human side label for stake acks. */
export function sideLabel(side: 'back' | 'doubt'): string {
  return side === 'back' ? 'Backing' : 'Doubting';
}
