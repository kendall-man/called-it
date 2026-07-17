/**
 * EVERY wager-mode user-facing string lives here and ONLY here — this is the
 * single module exempt from the vocabulary deny-list (stake/deposit/withdraw/
 * SOL are allowed). Nothing outside apps/engine/src/wager/ may import this
 * file (enforced by the seams slice's import-boundary test).
 *
 * Register: same game-show voice as bot/copy.ts, but real-stakes honest —
 * amounts are exact, "(mainnet)" is stamped on mainnet money movement, and
 * nothing promises more than the mechanics deliver. Devnet copy names test
 * assets plainly and never repeats value disclaimers: the one devnet
 * disclosure lives at wallet setup and on the receipt page.
 */

import type { WagerAsset } from '@calledit/market-engine';
import { formatAssetAmount, shortPubkey } from './format.js';
import { minimumDeposit, minimumWithdrawal } from './constants.js';
import type { SolanaNetwork } from '../solana-network.js';

export function createWagerCopy(network: SolanaNetwork, asset: WagerAsset = 'sol') {
  const mainnet = network === 'mainnet-beta';
  /** Appended after a sentence-ending period; devnet adds nothing. */
  const stamp = mainnet ? ' (mainnet)' : '';
  const code = asset === 'sol' ? 'SOL' : 'USDC';
  const assetLabel = mainnet ? code : `test ${code}`;
  const formatSolAmount = (amountAtomic: bigint): string => formatAssetAmount(amountAtomic, asset);
  return {
  // ── stake gates & results ────────────────────────────────────────────────
  unlinkedOnboarding: (): string =>
    `No verified wallet is linked. No ${code} moved. Open /wallet in private chat to create or recover your wallet.`,
  paused: (): string =>
    `${code} positions are temporarily paused. No ${code} moved. Try again later.`,
  marketClosed: (): string =>
    `That call is closed for new ${code} positions. No ${code} moved. Choose another call.`,
  starterUnavailable: (): string =>
    mainnet
      ? `That position is not available. No ${code} moved. Try another call.`
      : `The starter position is not available. No ${code} moved. Try another allowlisted beta group later.`,
  budgetExhausted: (): string =>
    mainnet
      ? `That position is not available. No ${code} moved. Try another call.`
      : `The starter position budget is used up. No ${code} moved. Try another allowlisted beta group later.`,
  walletRequired: (): string =>
    mainnet
      ? `A verified wallet is required. No ${code} moved. Open /wallet in private chat to check your status.`
      : `This beta only supports its one starter position. No ${code} moved. Try another allowlisted beta group later.`,
  insufficient: (balanceLamports: bigint): string =>
    `Not enough ${assetLabel} for that position. No ${code} moved. Available balance: ${formatSolAmount(balanceLamports)}.${stamp} Use /deposit ${asset} to add ${assetLabel}.`,
  pickALane: (): string => `You can't back it and doubt it. No ${code} moved. Pick a lane.`,
  capReached: (capLamports: bigint): string =>
    `You're maxed on this call — ${formatSolAmount(capLamports)} is the ceiling per market. No ${code} moved. Choose another call.`,
  stakePlaced: (name: string, sideLabel: string, lamports: bigint, multiplier: string): string =>
    `${name}'s position is recorded — ${sideLabel} with ${formatSolAmount(lamports)} at up to ×${multiplier}.${stamp}`,
  stakeReplayed: (): string => `Already got that one — your ${code} is on it.`,
  staleTap: (): string => 'That ship has sailed.',
  confirmationPrompt: (
    name: string,
    side: string,
    lamports: bigint,
    multiplier: string,
    terms: string,
  ): string =>
    `${name}, confirm ${formatSolAmount(lamports)} on "${side}" at up to ×${multiplier}. Call: ${terms}. ${code} moves only after Confirm. This expires in 2 minutes.`,
  confirmationSent: (): string => `Review the confirmation below. No ${code} has moved yet.`,
  confirmationCancelled: (): string => `Position cancelled. No ${code} moved.`,
  confirmationExpired: (): string => `That confirmation expired. No ${code} moved. Tap the call again.`,

  // ── /wallet ──────────────────────────────────────────────────────────────
  walletSetupUnavailable: (): string =>
    'Wallet setup is temporarily unavailable. No account state changed. Try /wallet again shortly.',
  walletSetupReady: (): string =>
    `Create a dedicated Solana ${mainnet ? 'mainnet' : 'devnet'} wallet for Called It, or recover one you already made.${mainnet ? '' : ' Runs on Solana devnet — these are test tokens.'} Your recovery key stays encrypted on your device. This private link expires in 5 minutes.`,
  walletPrivateOnly: (): string =>
    'For privacy, open my private chat and use /wallet there.',
  walletOverview: (
    pubkey: string,
    balances: Readonly<Record<WagerAsset, { availableAtomic: bigint; lockedAtomic: bigint }>>,
  ): string => {
    const sol = balances['sol'];
    const usdc = balances['usdc'];
    return [
      `Linked wallet: ${shortPubkey(pubkey)}.${stamp}`,
      `SOL available: ${formatAssetAmount(sol.availableAtomic, 'sol')} · locked: ${formatAssetAmount(sol.lockedAtomic, 'sol')}`,
      `USDC available: ${formatAssetAmount(usdc.availableAtomic, 'usdc')} · locked: ${formatAssetAmount(usdc.lockedAtomic, 'usdc')}`,
      'Use /deposit <sol|usdc> or /withdraw <sol|usdc> <amount|all>.',
    ].join('\n');
  },
  walletStatus: (pubkey: string, balanceLamports: bigint, lockedLamports = 0n): string =>
    `Linked wallet: ${shortPubkey(pubkey)}. Available ${code}: ${formatSolAmount(balanceLamports)}. Locked in open calls: ${formatSolAmount(lockedLamports)}.${stamp} Use /deposit ${asset} to add ${assetLabel} or /withdraw ${asset} <amount> to return available funds.`,

  // ── group asset selection ───────────────────────────────────────────────
  groupAssetStatus: (): string =>
    `New calls in this group use ${code}. Existing calls keep their original asset. Admins can change this with /currency sol or /currency usdc.`,
  groupAssetChanged: (): string =>
    `New calls in this group will use ${code}. Existing calls are unchanged.`,

  // ── /deposit ─────────────────────────────────────────────────────────────
  depositUsage: (): string =>
    'Usage: /deposit <sol|usdc>',
  depositInstructions: (treasuryPubkey: string, linked: boolean): string => {
    const lines = [
      mainnet
        ? `Add ${code} from your verified wallet to the Called It treasury —`
        : `Add test ${code} from your verified devnet wallet to the Called It treasury —`,
      treasuryPubkey,
      `Minimum ${formatSolAmount(minimumDeposit(asset))}; smaller sends are ignored. Send from your linked wallet; it credits automatically within a minute or so.`,
      mainnet
        ? asset === 'usdc'
          ? 'MAINNET ONLY. Send only native Circle USDC from your verified wallet.'
          : 'MAINNET ONLY. Send only SOL from your verified wallet.'
        : 'DEVNET ONLY. Do not send mainnet assets; they will not credit.',
    ];
    if (!linked) {
      lines.push(
        mainnet
          ? `No verified wallet is linked. Do not send ${code} until /wallet shows a verified wallet.`
          : `No verified wallet is linked. Open /wallet in private chat before sending ${code}.`,
      );
    }
    return lines.join('\n');
  },
  depositCredited: (name: string, lamports: bigint, balanceLamports: bigint): string =>
    `${name}'s deposit was recorded: ${formatSolAmount(lamports)}. Available balance: ${formatSolAmount(balanceLamports)}.${stamp}`,

  // ── /withdraw ────────────────────────────────────────────────────────────
  withdrawUsage: (): string =>
    `Usage: /withdraw ${asset} <amount|all> — sends ${mainnet ? 'mainnet' : 'devnet'} ${code} back to your linked wallet. Minimum ${formatSolAmount(minimumWithdrawal(asset))}.`,
  withdrawNoWallet: (): string =>
    `No verified wallet is available. No ${code} moved. Open /wallet in private chat first.`,
  withdrawBelowMin: (): string =>
    `Withdrawals start at ${formatSolAmount(minimumWithdrawal(asset))}. No ${code} moved. Choose a qualifying amount.`,
  withdrawInsufficient: (balanceLamports: bigint): string =>
    `Available balance: ${formatSolAmount(balanceLamports)}.${stamp} No ${code} moved. Choose a smaller amount.`,
  withdrawQueued: (lamports: bigint): string =>
    `Withdrawal queued: ${formatSolAmount(lamports)} to your verified wallet. I'll post the receipt when it confirms.${stamp}`,
  withdrawConfirmed: (name: string, lamports: bigint, explorerUrl: string): string =>
    `Withdrawal confirmed: ${formatSolAmount(lamports)} sent to ${name}'s verified wallet. Receipt: ${explorerUrl}${stamp}`,
  withdrawFailed: (name: string, lamports: bigint): string =>
    `${name}'s withdrawal was not submitted. ${formatSolAmount(lamports)} is available again. No ${code} left the account. Open /wallet in private chat before trying again.`,

  // ── card & receipt furniture ─────────────────────────────────────────────
  /** Devnet cards carry no footer — the escrow chip is the network context. */
  cardFooter: (): string =>
    mainnet ? `${code} positions settle on Solana mainnet.` : '',
  payoutsLineVoid: (): string => `Call off — every ${code} position returned.${stamp}`,
  payoutsLineNone: (): string => `No ${code} changed hands.${stamp}`,
  payoutPart: (name: string, lamports: bigint): string =>
    `${name} collects ${formatSolAmount(lamports)}`,
  payoutsLine: (parts: readonly string[], overflowCount = 0): string => {
    const overflow = overflowCount > 0
      ? `and ${overflowCount} more winners collect ${assetLabel}`
      : null;
    return `${[...parts, ...(overflow === null ? [] : [overflow])].join(' · ')}.${stamp}`;
  },

  // ── ops alerts (WAGER_OPS_CHAT_ID) ───────────────────────────────────────
  opsSolvencyAlert: (treasuryLamports: bigint, requiredLamports: bigint): string =>
    [
      `WAGER OPS — ${code} solvency breaker tripped. New ${code} positions are paused.`,
      `Treasury holds ${formatSolAmount(treasuryLamports)}; covering deposits, open stakes and the fee buffer needs ${formatSolAmount(requiredLamports)}.`,
      mainnet
        ? 'Top up the mainnet treasury — the breaker clears itself once covered.'
        : 'Top the devnet treasury up from a faucet — the breaker clears itself once covered.',
    ].join('\n'),
  opsSolvencyRecovered: (): string =>
    `WAGER OPS — treasury covers the ${code} book again. Breaker cleared, positions are back on.`,
  } as const;
}

export type WagerCopy = ReturnType<typeof createWagerCopy>;

/** Devnet remains the compatibility default for existing callers and tests. */
export const WAGER_COPY = createWagerCopy('devnet');

/** Human side label for stake acks. */
export function sideLabel(side: 'back' | 'doubt'): string {
  return side === 'back' ? 'Backing' : 'Doubting';
}
