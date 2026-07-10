import { describe, expect, it } from 'vitest';
import { FALLBACK_TEMPLATES, renderFallback, type TemplateKey } from './copy.js';

/**
 * Consumer-copy guard: the product owns betting language now, so only two bans
 * remain — FIAT currency (amounts are devnet SOL) and odds NOTATION (prices are
 * plain percentages). The agent package guards its own output; this suite
 * guards the engine's local fallbacks.
 */
const DENY_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'currency symbols', re: /[$£€¥]/ },
  { name: 'fiat currency words', re: /\b(dollars?|euros?|pounds?|usd|gbp|eur)\b/i },
  { name: 'fractional odds notation', re: /\b\d+\s*\/\s*\d+\b/ },
  { name: '"N-to-1" odds phrasing', re: /\b\d+\s*-?\s*to\s*-?\s*\d+\b/i },
  { name: 'retired Rep economy', re: /\bRep\b/i },
  { name: 'replay guidance', re: /\breplay\b/i },
  { name: 'cashout language', re: /\bcash\s*out\b/i },
  { name: 'stack language', re: /\bstack\b/i },
  { name: 'real-SOL framing', re: /\breal\s+(?:devnet\s+)?SOL\b/i },
];

const SAMPLE_VARS = {
  webUrl: 'https://example.test',
  addLink: 'https://t.me/footballcallit_bot?startgroup=calledit_v1&admin=manage_chat',
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
  payouts: 'Dee collects 0.01 test SOL.',
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

  it('speaks the direct test-SOL contract where it matters', () => {
    expect(renderFallback('var_freeze')).toMatch(/calls locked/i);
    expect(renderFallback('offer_live', SAMPLE_VARS)).toContain('It happens · 0.01 SOL');
    expect(renderFallback('offer_live', SAMPLE_VARS)).toContain('It does not · 0.01 SOL');
    expect(renderFallback('intro', SAMPLE_VARS)).toMatch(/test SOL/i);
    expect(renderFallback('intro', SAMPLE_VARS)).toMatch(/no monetary value/i);
    expect(renderFallback('void_market', SAMPLE_VARS)).not.toMatch(/\bRep\b/);
  });
});
