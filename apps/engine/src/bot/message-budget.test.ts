import type { MarketSpec } from '@calledit/market-engine';
import { describe, expect, it } from 'vitest';
import {
  claimCardText,
  receiptCardText,
  type ClaimCardInput,
  type ReceiptCardInput,
} from './cards.js';
import {
  composeTelegramMessage,
  normalizeInlineText,
  telegramMessageBody,
  truncateUtf16,
} from './message-budget.js';
import {
  leaderboardText,
  personalStatsText,
  settlementPointsText,
  sideListText,
  TELEGRAM_MESSAGE_LIMIT,
} from '../points/presentation.js';

const BROKEN_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

const SPEC: MarketSpec = {
  claimType: 'team_scores_n', fixtureId: 1234,
  entityRef: { kind: 'team', participant: 1, name: 'France' },
  comparator: 'gte', threshold: 2, period: 'FT_90', trustTier: 'chain_proven',
};

const CLAIM = {
  quotedText: 'France score twice', claimerName: 'Dee', spec: SPEC, status: 'open',
  probability: 0.42, provenance: 'modelled',
  back: { count: 100, stakeLamports: 50_000_000n },
  doubt: { count: 100, stakeLamports: 30_000_000n },
  matchedPct: 60, isReplay: false, receiptUrl: 'https://example.test/r/abc',
} satisfies ClaimCardInput;

const RECEIPT = {
  quotedText: CLAIM.quotedText, claimerName: CLAIM.claimerName, spec: SPEC,
  outcome: 'claim_won', probability: CLAIM.probability, provenance: CLAIM.provenance,
  payoutsLine: 'Dee collects 0.08 SOL. (devnet)', isReplay: false,
  receiptUrl: CLAIM.receiptUrl,
} satisfies ReceiptCardInput;

const IDENTITIES = Array.from({ length: 10 }, (_, index) => ({
  username: 'undefined', displayName: `\u0000\u202e${'🏆'.repeat(80)}${index}`,
}));
const IDENTITY_LABEL = '🏆'.repeat(32);

describe('Telegram message budgets', () => {
  it('normalizes an untrusted multiline field without splitting an emoji', () => {
    const text = normalizeInlineText(`  first\n\u0000second ${'🏆'.repeat(20)}`, 24, 'Call');

    expect(text.length).toBeLessThanOrEqual(24);
    expect(text).toMatch(/^first second /);
    expect(text).not.toMatch(/[\n\u0000]/);
    expect(text).not.toMatch(BROKEN_SURROGATE);
  });

  it('truncates garnish before preserving the complete mandatory body', () => {
    const body = 'Payout: exact\nReceipt: exact';
    const text = composeTelegramMessage({
      body, garnish: '🏆'.repeat(100), maxLength: 64,
    });

    expect(text.length).toBeLessThanOrEqual(64);
    expect(text.endsWith(body)).toBe(true);
    expect(text).not.toMatch(BROKEN_SURROGATE);
  });

  it('preserves a pending note ahead of the body when garnish overflows', () => {
    const body = 'It happens: exact\nReceipt: exact';
    const note = 'Held until lineups drop.';
    const text = composeTelegramMessage({
      body, note, garnish: '🏆'.repeat(100), maxLength: 80,
    });

    expect(text.length).toBeLessThanOrEqual(80);
    expect(text.endsWith(`${note}\n\n${body}`)).toBe(true);
    expect(text).not.toMatch(BROKEN_SURROGATE);
  });

  it('never silently truncates a mandatory body', () => {
    expect(() => telegramMessageBody('mandatory tail', 5)).toThrow(RangeError);
    expect(truncateUtf16('🏆🏆', 3)).toBe('...');
  });

  it('keeps presentation builders within a caller-supplied UTF-16 budget', () => {
    const participant = { username: null, displayName: '😀'.repeat(64) };
    const hundred = Array.from({ length: 100 }, () => participant);
    const player = { ...participant, points: 10, wins: 1, losses: 1 };
    for (const maxLength of [128, TELEGRAM_MESSAGE_LIMIT]) {
      const messages = [
        sideListText(hundred, maxLength),
        settlementPointsText(
          { winnerCount: 100, missCount: 100, winners: hundred, misses: hundred },
          maxLength,
        ),
        leaderboardText({ entries: Array.from({ length: 100 }, () => player), limit: 10 }, maxLength),
        personalStatsText({
          rank: 'outside_top_100', points: 10, wins: 1, losses: 1,
          currentStreak: 1, bestStreak: 1,
        }, maxLength),
      ];
      expect(messages.every((message) => message.length <= maxLength)).toBe(true);
    }
  });

  it('preserves every active section for 3,000 trophies and bounded side identities', () => {
    const active = claimCardText({
      ...CLAIM, quotedText: '🏆'.repeat(3_000),
      backParticipants: IDENTITIES.slice(0, 5), doubtParticipants: IDENTITIES.slice(0, 5),
      backParticipantCount: 100, doubtParticipantCount: 100,
    });
    const five = Array.from({ length: 5 }, () => IDENTITY_LABEL).join(', ');

    for (const line of [
      '⚡ France score 2+: 0.05 SOL (100 in)', "🛑 They don't: 0.03 SOL (100 in)",
      '🤝 Matched: 60%', `France score 2+: ${five}, and 95 more`,
      `They don't: ${five}, and 95 more`,
      'Receipt: https://example.test/r/abc',
    ]) expect(active).toContain(line);
    expect(active.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    expect(active).not.toMatch(BROKEN_SURROGATE);
  });

  it('preserves every final section for a 2,000-line call and bounded point identities', () => {
    const result = receiptCardText({
      ...RECEIPT,
      quotedText: Array.from({ length: 2_000 }, () => 'one line 🏆').join('\n'),
      points: {
        winnerCount: 100, missCount: 100, winners: IDENTITIES, misses: IDENTITIES,
        leaderboard: IDENTITIES.slice(0, 5).map((identity, index) => ({
          ...identity, points: 1_000 - index, wins: 100 - index, losses: index,
        })),
      },
    });
    const ten = Array.from({ length: 10 }, () => IDENTITY_LABEL).join(', ');

    for (const line of [
      '💠 Dee collects 0.08 SOL. (devnet)',
      `Winners (+10 points): ${ten}, and 90 more`,
      `Misses (+0 points): ${ten}, and 90 more`, 'Group leaderboard',
      '🔏 Chain-proven. Merkle proof lands on the receipt page',
      'Receipt: https://example.test/r/abc',
    ]) expect(result).toContain(line);
    expect(result.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    expect(result).not.toMatch(BROKEN_SURROGATE);
  });
});
