import { describe, expect, it } from 'vitest';
import { FALLBACK_TEMPLATES, renderFallback, type TemplateKey } from './copy.js';

/**
 * Persona-vocabulary guard (PRD testing priority 4): consumer copy is
 * game-show register — never sportsbook. The agent package guards its own
 * output; this suite guards the engine's local fallbacks.
 */
const DENY_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'currency symbols', re: /[$£€¥]/ },
  { name: 'fractional odds notation', re: /\b\d+\s*\/\s*\d+\b/ },
  { name: '"N-to-1" odds phrasing', re: /\b\d+\s*-?\s*to\s*-?\s*\d+\b/i },
  { name: 'bookie vocabulary', re: /\b(odds|bet|bets|betting|wager|bookie|bookmaker|punt|parlay|accumulator|bankroll|slip|payout odds)\b/i },
  { name: 'stake vocabulary', re: /\b(stake|stakes|staking|staked)\b/i },
];

const SAMPLE_VARS = {
  webUrl: 'https://example.test',
  addLink: 'https://t.me/CalledItBot?startgroup=true',
  claimer: 'Dee',
  probabilityPct: 9,
  question: 'in 90 minutes, or advancing on pens?',
  reason: "I can't chain-prove him personally — on-chain stats are team-level.",
  message: "Can't ground that fixture today.",
  terms: 'France to score 2 or more goals (90 minutes)',
  multiplier: '9',
  scorer: 'Mbappé',
  minute: 63,
  note: '2 open calls are feeling it.',
  payouts: 'Dee collects 225 Rep.',
  names: '@mark',
  balance: 40,
  cap: 100,
  name: 'Ana',
  side: 'Backing',
  stake: 50,
  summary: 'priced nudges are on',
  groupTitle: 'Sunday Legends',
  fixture: 'France vs Brazil',
} as const;

describe('fallback copy bank', () => {
  const keys = Object.keys(FALLBACK_TEMPLATES) as TemplateKey[];

  it('renders every template without throwing (with and without vars)', () => {
    for (const key of keys) {
      expect(typeof renderFallback(key, SAMPLE_VARS)).toBe('string');
      expect(typeof renderFallback(key)).toBe('string');
      expect(renderFallback(key, SAMPLE_VARS).length).toBeGreaterThan(0);
    }
  });

  it('never uses sportsbook vocabulary, odds notation, or currency symbols', () => {
    for (const key of keys) {
      const rendered = renderFallback(key, SAMPLE_VARS);
      for (const { name, re } of DENY_PATTERNS) {
        expect(re.test(rendered), `${key} violates deny-list (${name}): "${rendered}"`).toBe(false);
      }
    }
  });

  it('speaks in Rep and game-show register where it matters', () => {
    expect(renderFallback('var_freeze')).toMatch(/calls locked/i);
    expect(renderFallback('stake_locked', SAMPLE_VARS)).toMatch(/Rep/);
    expect(renderFallback('confirm_gate', SAMPLE_VARS)).toMatch(/×9 Rep/);
  });
});
