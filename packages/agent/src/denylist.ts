/**
 * Persona output guard — the compliance/judging requirement from the PRD:
 * game-show register, never sportsbook. Any consumer-facing string that trips
 * one of these patterns is rejected and the deterministic template ships
 * instead.
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
    pattern: /\b(?:dollars?|bucks?|quid|euros?|pounds?|usd|gbp|eur|cash|money)\b/i,
  },
  {
    name: 'bookie_vocabulary',
    pattern:
      /\b(?:bet|bets|betting|bettor|wager|wagers|wagered|wagering|bookie|bookies|bookmaker|bookmakers|sportsbook|bet\s*slip|betting\s*slip|parlay|accumulator|acca|punt|punts|punter|punters|stake|stakes|staked|staking|odds|moneyline|handicap|bankroll|payout\s*odds)\b/i,
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
