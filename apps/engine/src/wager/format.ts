import {
  formatAtomicAmount,
  formatWagerAmount,
  parseAtomicAmount,
  type WagerAsset,
} from '@calledit/market-engine';

/**
 * Lamports↔SOL display and parsing helpers. All arithmetic is bigint; the
 * only float anywhere in wager money math is the locked multiplier, which is
 * quantized to milli-units in settlement.ts.
 */

export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Boundary assert for lamports arriving as JS numbers (shared tables/RPC). */
export function assertSafeLamports(value: number, context: string): bigint {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${context}: lamports value ${value} is not a safe integer`);
  }
  return BigInt(value);
}

/** "0.01", "1.5", "0.000000123" — exact, trailing zeros trimmed. */
export function formatSol(lamports: bigint): string {
  return formatAtomicAmount(lamports, 'sol');
}

/** "0.05 SOL" — the standard user-facing amount rendering. */
export function formatSolAmount(lamports: bigint): string {
  return formatWagerAmount(lamports, 'sol');
}

export function formatAssetAmount(amountAtomic: bigint, asset: WagerAsset): string {
  return formatWagerAmount(amountAtomic, asset);
}

/** Parse a user-typed SOL amount ("0.05") into lamports; null when invalid. */
export function parseSolToLamports(text: string): bigint | null {
  return parseAtomicAmount(text, 'sol');
}

export function parseAssetAmount(text: string, asset: WagerAsset): bigint | null {
  return parseAtomicAmount(text, asset);
}

const PUBKEY_DISPLAY_EDGE = 4;

/** "AbCd…WxYz" — enough of an address to recognize, short enough for chat. */
export function shortPubkey(pubkey: string): string {
  if (pubkey.length <= PUBKEY_DISPLAY_EDGE * 2 + 1) return pubkey;
  return `${pubkey.slice(0, PUBKEY_DISPLAY_EDGE)}…${pubkey.slice(-PUBKEY_DISPLAY_EDGE)}`;
}
