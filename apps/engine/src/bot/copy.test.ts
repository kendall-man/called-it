import { describe, expect, it } from 'vitest';
import type { Logger } from '../log.js';
import type { AgentPort } from '../ports.js';
import { createSay, FALLBACK_TEMPLATES, renderFallback, type TemplateKey } from './copy.js';

/**
 * Consumer-copy guard for the engine's local fallbacks. The agent package
 * guards its own output separately.
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
  { name: 'stale aggregate receipt', re: /\baggregate\s+receipt\b/iu },
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
      expect(renderFallback(key, SAMPLE_VARS).length).toBeLessThanOrEqual(4096);
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

  it('rejects aggregate receipt wording across whitespace variants', () => {
    // Given mutations that split the retired phrase with valid whitespace
    const mutations = [
      'aggregate\treceipt',
      'aggregate\nreceipt',
      'aggregate \r\n\t receipt',
      'aggregate\u00a0receipt',
    ];
    const rule = DENY_PATTERNS.find(({ name }) => name === 'stale aggregate receipt');
    if (rule === undefined) throw new Error('aggregate receipt deny rule is missing');

    // When each mutation is checked
    // Then the same rendered-copy guard rejects every variant
    for (const mutation of mutations) expect(rule.re.test(mutation)).toBe(true);
  });

  it('speaks the direct test-SOL contract where it matters', () => {
    expect(renderFallback('var_freeze')).toMatch(/calls locked/i);
    expect(renderFallback('offer_live', SAMPLE_VARS)).toContain('It happens · 0.01 SOL');
    expect(renderFallback('offer_live', SAMPLE_VARS)).toContain('It does not · 0.01 SOL');
    expect(renderFallback('intro', SAMPLE_VARS)).toMatch(/test SOL/i);
    expect(renderFallback('intro', SAMPLE_VARS)).toMatch(/no monetary value/i);
    expect(renderFallback('void_market', SAMPLE_VARS)).not.toMatch(/\bRep\b/);
  });

  it('discloses named group visibility and automatic points in active guidance', () => {
    // Given the three deterministic guidance surfaces
    const guidance = [
      renderFallback('intro', SAMPLE_VARS),
      renderFallback('help', SAMPLE_VARS),
      renderFallback('group_ready', SAMPLE_VARS),
    ];

    // When a member reads any active guidance surface
    // Then the same privacy and points contract is explicit
    for (const line of guidance) {
      expect(line).toContain(
        'Choices and named results are visible to everyone in this Telegram group.',
      );
      expect(line).toContain('Correct choices earn 10 points automatically.');
    }
  });

  it('lists every active group command in the real help copy', () => {
    expect(renderFallback('help')).toContain(
      'Commands: /bookit · /leaderboard · /mystats · /table · /help',
    );
  });

  it('keeps points dependency failures fixed and redacted', () => {
    expect(renderFallback('points_unavailable', { message: 'database secret' })).toBe(
      'Points are temporarily unavailable. Try again shortly.',
    );
  });

  it('keeps privacy-critical guidance deterministic instead of using persona output', async () => {
    // Given a persona adapter that would return stale product language
    let personaCalls = 0;
    const agent: AgentPort = {
      prefilter: () => false,
      classify: async () => {
        throw new Error('classify is not used by copy tests');
      },
      parse: async () => {
        throw new Error('parse is not used by copy tests');
      },
      persona: async () => {
        personaCalls += 1;
        return 'Practice Rep';
      },
    };
    const log: Logger = {
      info() {},
      warn() {},
      error() {},
      child() {
        return this;
      },
    };
    const say = createSay(agent, log);
    const keys = [
      'intro',
      'help',
      'group_ready',
      'points_unavailable',
    ] as const satisfies readonly TemplateKey[];

    // When the contract-sensitive keys are rendered through the public copy API
    const lines = await Promise.all(keys.map((key) => say(key, SAMPLE_VARS)));

    // Then the controlled fallback bank is used without consulting persona variants
    expect(personaCalls).toBe(0);
    expect(lines).toEqual(keys.map((key) => renderFallback(key, SAMPLE_VARS)));
  });
});
