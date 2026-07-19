import { describe, expect, it } from 'vitest';
import type { Logger } from '../log.js';
import type { AgentPort } from '../ports.js';
import { GROUP_BOT_COMMANDS } from './bot.js';
import { createSay, FALLBACK_TEMPLATES, renderFallback, type TemplateKey } from './copy.js';
import { TELEGRAM_MESSAGE_LIMIT } from './message-budget.js';

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

const ACTIVE_STARTER_GUIDANCE_KEYS = [
  'intro',
  'help',
  'group_ready',
] as const satisfies readonly TemplateKey[];

const EXPECTED_STARTER_HELP = [
  'How this works:',
  '• Add Rumble to a Telegram group.',
  '• Reply /bookit to your own football call.',
  '• Pick a side, then an amount in the call asset.',
  '• SOL is the default. Group admins can use /currency sol or /currency usdc for new calls.',
  '• Choices and named results are visible to everyone in this Telegram group.',
  '• Correct choices earn 10 points automatically.',
  '',
  'Commands: /bookit · /leaderboard · /mystats · /table · /settings · /status · /currency · /testmatch · /endmatch · /help',
  'Runs on Solana devnet, these are test tokens.',
].join('\n');

const EXPECTED_STARTER_INTRO =
  'Add Rumble to a Telegram group. Reply /bookit to your own football call, then pick a side using test SOL or test USDC. SOL is the group default; admins can change new calls with /currency usdc. Choices and named results are visible to everyone in this Telegram group. Correct choices earn 10 points automatically. Runs on Solana devnet, these are test tokens.';

const UNAVAILABLE_STARTER_PATHS = [
  { name: 'wallet', pattern: /\bwallets?\b/i },
  { name: 'funding', pattern: /\bfund(?:ed|ing|s)?\b/i },
  { name: 'deposit', pattern: /\bdeposits?\b/i },
  { name: 'withdrawal', pattern: /\bwithdraw(?:al|als|s)?\b/i },
  { name: 'custody', pattern: /\bcustod(?:y|ial)\b/i },
  { name: 'pending funding', pattern: /\bpending\s+funding\b/i },
] as const;

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
    expect(renderFallback('offer_live', SAMPLE_VARS)).toContain('Pick a side below');
    expect(renderFallback('offer_live', SAMPLE_VARS)).toContain('0.01 SOL');
    expect(renderFallback('intro', SAMPLE_VARS)).toMatch(/test SOL/i);
    // Voice rule: the devnet disclosure is one confident line, never a nag.
    expect(renderFallback('intro', SAMPLE_VARS)).toContain('Runs on Solana devnet, these are test tokens.');
    expect(renderFallback('intro', SAMPLE_VARS)).not.toMatch(/no monetary value/i);
    expect(renderFallback('void_market', SAMPLE_VARS)).not.toMatch(/\bRep\b/);
  });

  it('renders mainnet onboarding without devnet or test-token claims', () => {
    const guidance = [
      renderFallback('intro', SAMPLE_VARS, 'mainnet-beta'),
      renderFallback('help', SAMPLE_VARS, 'mainnet-beta'),
      renderFallback('group_ready', SAMPLE_VARS, 'mainnet-beta'),
      renderFallback('insufficient_rep', SAMPLE_VARS, 'mainnet-beta'),
    ].join('\n');

    expect(guidance).not.toMatch(/devnet|test SOL|no monetary value/i);
    expect(guidance).toMatch(/Solana mainnet/i);
    expect(guidance).toContain('/wallet');
    expect(guidance).toContain('/deposit');
  });

  it('explains escrow without presenting Rumble as the wallet custodian', () => {
    const vars = { ...SAMPLE_VARS, custodyMode: 'escrow' };
    const guidance = [
      renderFallback('intro', vars, 'mainnet-beta'),
      renderFallback('help', vars, 'mainnet-beta'),
      renderFallback('group_ready', vars, 'mainnet-beta'),
    ].join('\n');

    expect(guidance).toContain('On-chain escrow');
    expect(guidance).toContain('Privy wallet');
    expect(guidance).toContain('Legacy /deposit and /withdraw');
    expect(guidance).not.toContain('add funds to your Rumble balance');
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

  it('does not advertise flexible amounts or a private account in starter guidance', () => {
    // Given the deterministic Telegram guidance used by the starter-only runtime
    const guidance = ACTIVE_STARTER_GUIDANCE_KEYS.map((key) => renderFallback(key, SAMPLE_VARS));

    // When a member reads any active starter guidance surface
    // Then no unavailable amount picker or private-account route is promised
    for (const line of guidance) {
      expect(line).not.toMatch(/\bChoose amount\b|\blarger test-SOL options?\b/i);
      expect(line).not.toMatch(/\/me\b|\bprivate account\b/i);
    }
  });

  it('does not advertise unavailable wallet or funding paths in starter guidance', () => {
    // Given the deterministic Telegram guidance used by the starter-only runtime
    const guidance = ACTIVE_STARTER_GUIDANCE_KEYS.map((key) => ({
      key,
      text: renderFallback(key, SAMPLE_VARS),
    }));

    // When each active guidance surface is checked for funded-runtime promises
    // Then wallet, funding, deposit, withdrawal, custody, and pending funding stay absent
    for (const { key, text } of guidance) {
      for (const path of UNAVAILABLE_STARTER_PATHS) {
        expect(
          path.pattern.test(text),
          `${key} advertises unavailable ${path.name} guidance: "${text}"`,
        ).toBe(false);
      }
    }
  });

  it('renders the exact Telegram starter help', () => {
    // Given the starter-only help contract
    const help = renderFallback('help');

    // When Telegram receives the deterministic help message
    // Then its copy and UTF-16 length remain exact and within Telegram's limit
    expect(help).toBe(EXPECTED_STARTER_HELP);
    expect(help.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
  });

  it('renders only the direct starter group flow in the intro', () => {
    // Given the deterministic starter intro
    const intro = renderFallback('intro', SAMPLE_VARS);

    // When the introductory guidance is rendered
    // Then it contains the complete direct group flow without optional paths
    expect(intro).toBe(EXPECTED_STARTER_INTRO);
  });

  it('keeps the help command list consistent with Telegram group commands', () => {
    // Given the registered Telegram group menu and rendered help
    const configuredCommands = GROUP_BOT_COMMANDS.map(({ command }) => `/${command}`);

    // When the explicit command line is read from help
    const commandLine = renderFallback('help')
      .split('\n')
      .find((line) => line.startsWith('Commands:'));
    const listedCommands = commandLine?.match(/\/[a-z]+/gu) ?? [];

    // Then help lists every configured group command once and in menu order
    expect(listedCommands).toEqual(configuredCommands);
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
