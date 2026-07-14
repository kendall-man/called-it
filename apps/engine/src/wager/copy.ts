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
import type { SolanaNetwork } from '../solana-network.js';

export function createWagerCopy(network: SolanaNetwork) {
  const mainnet = network === 'mainnet-beta';
  const networkStamp = mainnet ? '(mainnet)' : '(devnet)';
  const solLabel = mainnet ? 'SOL' : 'test SOL';
  return {
  // ── stake gates & results ────────────────────────────────────────────────
  unlinkedOnboarding: (): string =>
    mainnet
      ? 'No verified wallet is linked. No SOL moved. Open /wallet in private chat to create or recover your wallet.'
      : 'No verified wallet is linked. Test SOL is a devnet token with no monetary value. No SOL moved. Open /wallet in private chat to create or recover your wallet.',
  paused: (): string =>
    mainnet
      ? 'SOL positions are temporarily paused. No SOL moved. Try again later.'
      : 'Starter positions are temporarily paused. No SOL moved. Try another allowlisted beta group later.',
  marketClosed: (): string =>
    'That call is closed for new SOL positions. No SOL moved. Choose another call.',
  starterUnavailable: (): string =>
    mainnet
      ? 'That position is not available. No SOL moved. Try another call.'
      : 'The starter position is not available. No SOL moved. Try another allowlisted beta group later.',
  budgetExhausted: (): string =>
    mainnet
      ? 'That position is not available. No SOL moved. Try another call.'
      : 'The starter position budget is used up. No SOL moved. Try another allowlisted beta group later.',
  walletRequired: (): string =>
    mainnet
      ? 'A verified wallet is required. No SOL moved. Open /wallet in private chat to check your status.'
      : 'This beta only supports its one starter position. No SOL moved. Try another allowlisted beta group later.',
  insufficient: (balanceLamports: bigint): string =>
    `Not enough ${solLabel} for that position. No SOL moved. Available balance: ${formatSolAmount(balanceLamports)} ${networkStamp}. Use /deposit to add ${solLabel}.`,
  pickALane: (): string => "You can't back it and doubt it. No SOL moved. Pick a lane.",
  capReached: (capLamports: bigint): string =>
    `You're maxed on this call — ${formatSolAmount(capLamports)} is the ceiling per market. No SOL moved. Choose another call.`,
  stakePlaced: (name: string, sideLabel: string, lamports: bigint, multiplier: string): string =>
    mainnet
      ? `${name}'s position is recorded — ${sideLabel} with ${formatSolAmount(lamports)} at up to ×${multiplier}. (mainnet)`
      : `${name}'s position is recorded — ${sideLabel} with ${formatSolAmount(lamports)} at up to ×${multiplier}. Test SOL is a devnet token with no monetary value.`,
  stakeReplayed: (): string => "Already got that one — your SOL's on it.",
  staleTap: (): string => 'That ship has sailed.',
  confirmationPrompt: (
    name: string,
    side: string,
    lamports: bigint,
    multiplier: string,
    terms: string,
  ): string =>
    `${name}, confirm ${formatSolAmount(lamports)} on "${side}" at up to ×${multiplier}. Call: ${terms}. SOL moves only after Confirm. This expires in 2 minutes.`,
  confirmationSent: (): string => 'Review the confirmation below. No SOL has moved yet.',
  confirmationCancelled: (): string => 'Position cancelled. No SOL moved.',
  confirmationExpired: (): string => 'That confirmation expired. No SOL moved. Tap the call again.',

  // ── /wallet ──────────────────────────────────────────────────────────────
  walletSetupUnavailable: (): string =>
    'Wallet setup is temporarily unavailable. No account state changed. Try /wallet again shortly.',
  walletSetupReady: (): string =>
    `Create a dedicated Solana ${mainnet ? 'mainnet' : 'devnet'} wallet for Called It, or recover one you already made. Your recovery key stays encrypted on your device. This private link expires in 5 minutes.`,
  walletPrivateOnly: (): string =>
    'For privacy, open my private chat and use /wallet there.',
  walletStatus: (pubkey: string, balanceLamports: bigint, lockedLamports = 0n): string =>
    `Linked wallet: ${shortPubkey(pubkey)}. Available to use: ${formatSolAmount(balanceLamports)}. Locked in open calls: ${formatSolAmount(lockedLamports)}. ${networkStamp} Use /deposit to add ${solLabel} or /withdraw to return available funds.`,

  // ── /deposit ─────────────────────────────────────────────────────────────
  depositInstructions: (treasuryPubkey: string, linked: boolean): string => {
    const lines = [
      mainnet
        ? 'Add SOL by sending a Solana mainnet transfer to the table treasury —'
        : 'Add test SOL by sending a devnet transfer to the table treasury —',
      treasuryPubkey,
      `Minimum ${formatSolAmount(WAGER_TUNABLES.MIN_DEPOSIT_LAMPORTS)}; smaller sends are ignored. Plain transfer from your linked wallet, no memo needed — it credits automatically within a minute or so.`,
      mainnet
        ? 'MAINNET ONLY. Send only SOL from your verified wallet.'
        : 'DEVNET ONLY. Test SOL has no monetary value. Do not send mainnet SOL; it will not credit and cannot be returned.',
    ];
    if (!linked) {
      lines.push(
        mainnet
          ? 'No verified wallet is linked. Do not send SOL until /wallet shows a verified wallet; unverified transfers do not credit automatically.'
          : 'No verified wallet is linked. Open /wallet in private chat first; transfers remain pending until verification completes.',
      );
    }
    return lines.join('\n');
  },
  depositCredited: (name: string, lamports: bigint, balanceLamports: bigint): string =>
    `${name}'s deposit was recorded: ${formatSolAmount(lamports)}. Available balance: ${formatSolAmount(balanceLamports)}. ${networkStamp}`,

  // ── /withdraw ────────────────────────────────────────────────────────────
  withdrawUsage: (): string =>
    `Usage: /withdraw <amount|all> — sends ${mainnet ? 'mainnet' : 'devnet'} SOL back to your linked wallet. Minimum ${formatSolAmount(WAGER_TUNABLES.MIN_WITHDRAWAL_LAMPORTS)}.`,
  withdrawNoWallet: (): string =>
    'No verified wallet is available. No SOL moved. Open /wallet in private chat first.',
  withdrawBelowMin: (): string =>
    `Withdrawals start at ${formatSolAmount(WAGER_TUNABLES.MIN_WITHDRAWAL_LAMPORTS)}. No SOL moved. Choose a qualifying amount.`,
  withdrawInsufficient: (balanceLamports: bigint): string =>
    `Available balance: ${formatSolAmount(balanceLamports)} ${networkStamp}. No SOL moved. Choose a smaller amount.`,
  withdrawQueued: (lamports: bigint): string =>
    `Withdrawal queued: ${formatSolAmount(lamports)} to your verified wallet. I'll post the receipt when it confirms. ${networkStamp}`,
  withdrawConfirmed: (name: string, lamports: bigint, explorerUrl: string): string =>
    `Withdrawal confirmed: ${formatSolAmount(lamports)} sent to ${name}'s verified wallet. Receipt: ${explorerUrl} ${networkStamp}`,
  withdrawFailed: (name: string, lamports: bigint): string =>
    `${name}'s withdrawal was not submitted. ${formatSolAmount(lamports)} is available again. No SOL left the account. Open /wallet in private chat before trying again.`,

  // ── card & receipt furniture ─────────────────────────────────────────────
  cardFooter: (): string =>
    mainnet ? 'SOL positions settle on Solana mainnet.' : 'Test SOL is a devnet token with no monetary value.',
  payoutsLineVoid: (): string => `Call off — every SOL stake returned. ${networkStamp}`,
  payoutsLineNone: (): string => `No SOL changed hands. ${networkStamp}`,
  payoutPart: (name: string, lamports: bigint): string =>
    `${name} collects ${formatSolAmount(lamports)}`,
  payoutsLine: (parts: readonly string[], overflowCount = 0): string => {
    const overflow = overflowCount > 0
      ? `and ${overflowCount} more winners collect ${solLabel}`
      : null;
    return `${[...parts, ...(overflow === null ? [] : [overflow])].join(' · ')}. ${networkStamp}`;
  },

  // ── ops alerts (WAGER_OPS_CHAT_ID) ───────────────────────────────────────
  opsSolvencyAlert: (treasuryLamports: bigint, requiredLamports: bigint): string =>
    [
      'WAGER OPS — solvency breaker tripped. New stakes are paused.',
      `Treasury holds ${formatSolAmount(treasuryLamports)}; covering deposits, open stakes and the fee buffer needs ${formatSolAmount(requiredLamports)}.`,
      mainnet
        ? 'Top up the mainnet treasury — the breaker clears itself once covered.'
        : 'Top the devnet treasury up from a faucet — the breaker clears itself once covered.',
    ].join('\n'),
  opsSolvencyRecovered: (): string =>
    'WAGER OPS — treasury covers the book again. Breaker cleared, stakes are back on.',
  } as const;
}

export type WagerCopy = ReturnType<typeof createWagerCopy>;

/** Devnet remains the compatibility default for existing callers and tests. */
export const WAGER_COPY = createWagerCopy('devnet');

/** Human side label for stake acks. */
export function sideLabel(side: 'back' | 'doubt'): string {
  return side === 'back' ? 'Backing' : 'Doubting';
}
