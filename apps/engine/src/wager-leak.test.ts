/**
 * Wager-mode leak compliance:
 * 1. No public-facing copy or Rep card path may emit pubkeys, lamports, or
 *    SOL/devnet vocabulary — those strings exist only inside the wager copy module.
 * 2. Import boundary: nothing outside apps/engine/src/wager/ may import the
 *    wager copy module, and every static import of wager modules from outside
 *    the directory must be type-only (wiring.ts's gated dynamic import of the
 *    wager module is the single allowed runtime reachability point).
 * 3. Callback data encoding for stake buttons is unchanged by preset labels.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MarketSpec } from '@calledit/market-engine';
import { FALLBACK_TEMPLATES, renderFallback, type TemplateKey } from './bot/copy.js';
import { claimCardText, receiptCardText } from './bot/cards.js';
import { marketStakeKeyboard, settingsKeyboard, stakeKeyboard } from './bot/keyboards.js';
import type { Deps, MarketRow } from './ports.js';

// ── Leak patterns: what must NEVER appear outside the wager copy module ───

const LEAK_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'lamports', re: /lamport/i },
  { name: 'SOL token name', re: /\bsol\b/i },
  { name: 'devnet vocabulary', re: /devnet/i },
  // 32-44 chars of the base58 alphabet = a Solana pubkey shape.
  { name: 'base58 pubkey shape', re: /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/ },
];

function expectNoLeaks(text: string, context: string): void {
  for (const { name, re } of LEAK_PATTERNS) {
    expect(re.test(text), `${context} leaks ${name}: "${text}"`).toBe(false);
  }
}

const SAMPLE_VARS = {
  webUrl: 'https://example.test',
  addLink: 'https://t.me/CalledItBot?startgroup=true',
  claimer: 'Dee',
  probabilityPct: 9,
  question: 'in 90 minutes, or advancing on pens?',
  reason: "I can't chain-prove him personally.",
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
  payout: 225,
  url: 'https://example.test/r/abc',
  offer: 'France to win (in 90 minutes)',
} as const;

const REP_SPEC: MarketSpec = {
  claimType: 'match_winner',
  fixtureId: 42,
  entityRef: { kind: 'team', participant: 1, name: 'Egypt' },
  comparator: 'gte',
  threshold: 1,
  period: 'FT_90',
  trustTier: 'oracle_resolved',
};

describe('public copy surface stays pubkey/lamport-free', () => {
  it('every fallback template renders without wager vocabulary or pubkey shapes', () => {
    const keys = Object.keys(FALLBACK_TEMPLATES) as TemplateKey[];
    for (const key of keys) {
      expectNoLeaks(renderFallback(key, SAMPLE_VARS), `template ${key}`);
      expectNoLeaks(renderFallback(key), `template ${key} (no vars)`);
    }
  });

  it('the Rep claim card carries no footer and no leak vocabulary', () => {
    const text = claimCardText({
      quotedText: 'Egypt win this',
      claimerName: 'Dee',
      spec: REP_SPEC,
      status: 'open',
      probability: 0.6,
      multiplier: 1.6,
      provenance: 'market',
      back: { count: 2, totalRep: 75 },
      doubt: { count: 1, totalRep: 25 },
      isReplay: false,
      receiptUrl: 'https://example.test/r/abc',
      tableUrl: 'https://example.test/g/sunday-legends',
    });
    expectNoLeaks(text, 'Rep claim card');
    // Byte-identity of the Rep card tail: nothing appended after the links.
    expect(text.endsWith('Table: https://example.test/g/sunday-legends')).toBe(true);
  });

  it('the Rep receipt card carries no leak vocabulary', () => {
    const text = receiptCardText({
      quotedText: 'Egypt win this',
      claimerName: 'Dee',
      spec: REP_SPEC,
      outcome: 'claim_won',
      probability: 0.6,
      multiplier: 1.6,
      provenance: 'market',
      payoutsLine: 'Dee collects 120 Rep.',
      isReplay: false,
      receiptUrl: 'https://example.test/r/abc',
    });
    expectNoLeaks(text, 'Rep receipt card');
  });
});

describe('preset labels change button text only — never the callback encoding', () => {
  const MARKET_ID = '0f14d0ab-9605-4a62-a9e4-5ed26688389b';

  function repMarket(currency?: 'rep' | 'sol'): MarketRow {
    return { id: MARKET_ID, ...(currency !== undefined ? { currency } : {}) } as MarketRow;
  }

  it('rep markets (and sol markets with the module off) render main-identical keyboards', () => {
    const noModule = { wager: null } as unknown as Deps;
    const baseline = JSON.stringify(stakeKeyboard(MARKET_ID).inline_keyboard);
    expect(JSON.stringify(marketStakeKeyboard(noModule, repMarket()).inline_keyboard)).toBe(baseline);
    expect(JSON.stringify(marketStakeKeyboard(noModule, repMarket('rep')).inline_keyboard)).toBe(baseline);
    // Degrade: sol market while the module is off still renders (taps answer stale).
    expect(JSON.stringify(marketStakeKeyboard(noModule, repMarket('sol')).inline_keyboard)).toBe(baseline);
  });

  it('sol markets swap labels from the module but keep the exact callback data', () => {
    const withModule = {
      wager: { presetLabels: () => ['0.01', '0.05', '0.1'] },
    } as unknown as Deps;
    const buttons = marketStakeKeyboard(withModule, repMarket('sol')).inline_keyboard.flat();
    expect(buttons.map((b) => b.text)).toContain('⚡ Back 0.01');
    const data = buttons.map((b) => ('callback_data' in b ? b.callback_data : ''));
    const baselineData = stakeKeyboard(MARKET_ID)
      .inline_keyboard.flat()
      .map((b) => ('callback_data' in b ? b.callback_data : ''));
    expect(data).toEqual(baselineData);
  });

  it('the settings devnet-SOL row uses deny-list-clean wording', () => {
    const rows = settingsKeyboard('nudge', true, { enabled: true }).inline_keyboard.flat();
    const wagerRow = rows.find((b) => 'callback_data' in b && b.callback_data.startsWith('wg:'));
    expect(wagerRow).toBeDefined();
    // The literal word list from the deny set must not appear on the button.
    expect(/\b(bet|bets|betting|wager|wagers|stake|stakes|odds)\b/i.test(wagerRow!.text)).toBe(false);
  });
});

// ── Import boundary ────────────────────────────────────────────────────────

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
// Built via join so this test file does not trip its own scan.
const COPY_NEEDLE = ['wager', 'copy'].join('/');

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(full));
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

function filesOutsideWagerDir(): Array<{ path: string; content: string }> {
  return listSourceFiles(SRC_DIR)
    .filter((file) => !relative(SRC_DIR, file).startsWith(`wager${sep}`))
    .map((file) => ({ path: relative(SRC_DIR, file), content: readFileSync(file, 'utf8') }));
}

describe('wager copy is only reachable through the module', () => {
  it('no file outside wager/ references the wager copy module', () => {
    for (const { path, content } of filesOutsideWagerDir()) {
      expect(content.includes(COPY_NEEDLE), `${path} references ${COPY_NEEDLE}`).toBe(false);
    }
  });

  it('every static wager import outside wager/ is type-only', () => {
    const staticImport = /import\s+(type\s)?[^'"]*from\s+'[^']*wager\/[^']*'/g;
    for (const { path, content } of filesOutsideWagerDir()) {
      for (const match of content.matchAll(staticImport)) {
        expect(
          match[1],
          `${path} has a runtime (non-type) import of a wager module: ${match[0]}`,
        ).toBeDefined();
      }
    }
  });

  it('the only dynamic wager import lives in wiring.ts and targets module.js', () => {
    const dynamicImport = /import\(\s*'([^']*wager\/[^']*)'\s*\)/g;
    for (const { path, content } of filesOutsideWagerDir()) {
      for (const match of content.matchAll(dynamicImport)) {
        expect(path, `unexpected dynamic wager import in ${path}`).toBe('wiring.ts');
        expect(match[1]).toBe('./wager/module.js');
      }
    }
  });
});
