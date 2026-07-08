/**
 * Persona output guard. The product now owns betting language ("bet / stake /
 * against" are fine), but two bans remain: odds NOTATION (we speak in plain
 * percentages, never "11/1" or "@2.5") and FIAT currency (amounts are devnet
 * SOL, never dollars/euros/$). Any consumer-facing string that trips a pattern
 * is rejected and the deterministic template ships instead.
 */

export interface DenyListPattern {
  /** Stable name for logs and tests. */
  name: string;
  pattern: RegExp;
}

export const DENY_LIST_PATTERNS: readonly DenyListPattern[] = [
  {
    // "11/1", "9 / 2" — fractional odds notation.
    name: 'odds_fraction',
    pattern: /\b\d+\s*\/\s*\d+\b/,
  },
  {
    // "9-to-1", "9 to 1" — spoken odds notation.
    name: 'odds_spoken',
    pattern: /\b\d+(?:\.\d+)?\s*-?\s*to\s*-?\s*\d+(?:\.\d+)?\b/i,
  },
  {
    // "@ 2.5" — price-quote notation.
    name: 'odds_at_price',
    pattern: /@\s*\d+(?:\.\d+)?\b/,
  },
  {
    name: 'currency_symbol',
    pattern: /[$£€¥₩₽¢]/,
  },
  {
    name: 'currency_word',
    pattern: /\b(?:dollars?|bucks?|quid|euros?|pounds?|usd|gbp|eur)\b/i,
  },
];

export interface DenyListViolation {
  name: string;
  match: string;
}

/** Returns the first violation found, or null when the text is clean. */
export function violatesDenyList(text: string): DenyListViolation | null {
  for (const { name, pattern } of DENY_LIST_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return { name, match: match[0] };
  }
  return null;
}
