/**
 * Lamports↔SOL display and parsing helpers. All arithmetic is bigint; the
 * only float anywhere in wager money math is the locked multiplier, which is
 * quantized to milli-units in settlement.ts.
 */

export const LAMPORTS_PER_SOL = 1_000_000_000n;
const SOL_DECIMALS = 9;

/** Boundary assert for lamports arriving as JS numbers (shared tables/RPC). */
export function assertSafeLamports(value: number, context: string): bigint {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${context}: lamports value ${value} is not a safe integer`);
  }
  return BigInt(value);
}

/** "0.01", "1.5", "0.000000123" — exact, trailing zeros trimmed. */
export function formatSol(lamports: bigint): string {
  const negative = lamports < 0n;
  const magnitude = negative ? -lamports : lamports;
  const whole = magnitude / LAMPORTS_PER_SOL;
  const frac = magnitude % LAMPORTS_PER_SOL;
  const fracText = frac.toString().padStart(SOL_DECIMALS, '0').replace(/0+$/, '');
  const body = fracText.length > 0 ? `${whole}.${fracText}` : whole.toString();
  return negative ? `-${body}` : body;
}

/** "0.05 SOL" — the standard user-facing amount rendering. */
export function formatSolAmount(lamports: bigint): string {
  return `${formatSol(lamports)} SOL`;
}

const SOL_AMOUNT_PATTERN = /^(\d+)(?:\.(\d{1,9}))?$/;

/** Parse a user-typed SOL amount ("0.05") into lamports; null when invalid. */
export function parseSolToLamports(text: string): bigint | null {
  const match = SOL_AMOUNT_PATTERN.exec(text.trim());
  if (!match) return null;
  const whole = BigInt(match[1] ?? '0');
  const fracDigits = (match[2] ?? '').padEnd(SOL_DECIMALS, '0');
  return whole * LAMPORTS_PER_SOL + BigInt(fracDigits === '' ? '0' : fracDigits);
}

const PUBKEY_DISPLAY_EDGE = 4;

/** "AbCd…WxYz" — enough of an address to recognize, short enough for chat. */
export function shortPubkey(pubkey: string): string {
  if (pubkey.length <= PUBKEY_DISPLAY_EDGE * 2 + 1) return pubkey;
  return `${pubkey.slice(0, PUBKEY_DISPLAY_EDGE)}…${pubkey.slice(-PUBKEY_DISPLAY_EDGE)}`;
}
