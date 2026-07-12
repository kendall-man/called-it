import { describe, expect, it } from 'vitest';
import type { MarketSpec } from '@calledit/market-engine';
import {
  claimCardText,
  describeTerms,
  formatMultiplier,
  formatProbabilityPct,
  receiptCardText,
  type ClaimCardInput,
  type ReceiptCardInput,
} from './cards.js';

const TEAM_SPEC: MarketSpec = {
  claimType: 'team_scores_n',
  fixtureId: 1234,
  entityRef: { kind: 'team', participant: 1, name: 'France' },
  comparator: 'gte',
  threshold: 2,
  period: 'FT_90',
  trustTier: 'chain_proven',
};

const COMEBACK_SPEC: MarketSpec = {
  claimType: 'comeback',
  fixtureId: 1234,
  entityRef: { kind: 'team', participant: 2, name: 'Brazil' },
  comparator: 'gte',
  threshold: 1,
  period: 'FT',
  anchor: { seq: 41, scoreP1: 1, scoreP2: 0 },
  trustTier: 'oracle_resolved',
};

const CLAIM_INPUT = {
  quotedText: 'France score twice today, easy',
  claimerName: 'Dee',
  spec: TEAM_SPEC,
  status: 'open',
  probability: 0.42,
  provenance: 'modelled',
  back: { count: 2, stakeLamports: 50_000_000n },
  doubt: { count: 1, stakeLamports: 30_000_000n },
  matchedPct: 60,
  isReplay: false,
  receiptUrl: 'https://example.test/r/abc',
} satisfies ClaimCardInput;

const RECEIPT_INPUT = {
  quotedText: CLAIM_INPUT.quotedText,
  claimerName: CLAIM_INPUT.claimerName,
  spec: TEAM_SPEC,
  outcome: 'claim_won',
  probability: CLAIM_INPUT.probability,
  provenance: CLAIM_INPUT.provenance,
  payoutsLine: 'Dee collects 0.08 SOL. (devnet)',
  isReplay: false,
  receiptUrl: CLAIM_INPUT.receiptUrl,
} satisfies ReceiptCardInput;

describe('formatters', () => {
  it('renders multipliers as ×N, never odds notation', () => {
    expect(formatMultiplier(9.3)).toBe('×9.3');
    expect(formatMultiplier(9.0)).toBe('×9');
    expect(formatMultiplier(11.4)).toBe('×11');
    expect(formatMultiplier(1.02)).toBe('×1');
    expect(formatMultiplier(25)).toBe('×25');
  });

  it('formats probabilities as whole percentages with <1/>99 guards', () => {
    expect(formatProbabilityPct(0.09)).toBe('9');
    expect(formatProbabilityPct(0.005)).toBe('<1');
    expect(formatProbabilityPct(0.999)).toBe('>99');
  });
});

describe('describeTerms', () => {
  it('describes a team-goals spec in plain English', () => {
    expect(describeTerms(TEAM_SPEC)).toBe('France to score 2 or more goals (in 90 minutes)');
  });

  it('describes a comeback with its anchored deficit', () => {
    expect(describeTerms(COMEBACK_SPEC)).toContain('from 1-0 down');
    expect(describeTerms(COMEBACK_SPEC)).toContain('Brazil');
  });
});

describe('cards', () => {
  const card = claimCardText(CLAIM_INPUT);

  it('keeps the existing financial totals and receipt lines unchanged', () => {
    const receipt = receiptCardText(RECEIPT_INPUT);

    expect(card).toContain(
      [
        '⚡ Backing it: 0.05 SOL (2 in)',
        '🛑 Against it: 0.03 SOL (1 in)',
        '🤝 Matched: 60%',
        '',
        'Receipt: https://example.test/r/abc',
      ].join('\n'),
    );
    expect(receipt).toContain('💠 Dee collects 0.08 SOL. (devnet)');
    expect(receipt).toMatch(/Receipt: https:\/\/example\.test\/r\/abc$/);
  });

  it('claim card carries terms, feed price, SOL pots, matched %, and the receipt link', () => {
    expect(card).toContain('France to score 2 or more goals');
    expect(card).toContain('42%');
    // Full-match multipliers derive from the feed ratio (p=0.42): back ×2.4, against ×1.7.
    expect(card).toContain('×2.4');
    expect(card).toContain('×1.7');
    expect(card).toContain('modelled price');
    expect(card).toContain('0.05 SOL'); // backing pot
    expect(card).toContain('0.03 SOL'); // against pot
    expect(card).toContain('Matched: 60%');
    expect(card).toContain('https://example.test/r/abc');
  });

  it('shows participant sides with the ongoing group disclosure', () => {
    const namedCard = claimCardText({
      ...CLAIM_INPUT,
      backParticipants: [
        { username: 'alice_7', displayName: 'Alice' },
        { username: null, displayName: 'Bob' },
      ],
      doubtParticipants: [{ username: 'carol_9', displayName: 'Carol' }],
    });

    expect(namedCard).toContain(
      [
        'It happens: @alice_7, Bob',
        'It does not: @carol_9',
        'Choices and results are visible in this group.',
      ].join('\n'),
    );
  });

  it('keeps financial positions separate from distinct participant overflow', () => {
    const duplicateOnlyCard = claimCardText({
      ...CLAIM_INPUT,
      back: { count: 6, stakeLamports: 60_000_000n },
      doubt: { count: 0, stakeLamports: 0n },
      backParticipants: [{ username: 'alice_7', displayName: 'Alice' }],
      doubtParticipants: [],
      backParticipantCount: 1,
      doubtParticipantCount: 0,
    });

    expect(duplicateOnlyCard).toContain('⚡ Backing it: 0.06 SOL (6 in)');
    expect(duplicateOnlyCard).toContain('It happens: @alice_7');
    expect(duplicateOnlyCard).not.toContain('and 5 more');
  });

  it('caps and sanitizes 100 participant identities within the Telegram limit', () => {
    const participants = Array.from({ length: 100 }, (_, index) => ({
      username: index < 5 ? `player_${index}` : 'undefined',
      displayName: `\u0000\u202e Player ${index} 🏆`.repeat(4),
    }));
    const boundedCard = claimCardText({
      ...CLAIM_INPUT,
      back: { count: 100, stakeLamports: 1_000_000_000n },
      doubt: { count: 0, stakeLamports: 0n },
      backParticipants: participants,
      doubtParticipants: [],
      backParticipantCount: 100,
      doubtParticipantCount: 0,
      matchedPct: 0,
    });

    expect(boundedCard).toContain(
      'It happens: @player_0, @player_1, @player_2, @player_3, @player_4, and 95 more',
    );
    expect(boundedCard).toContain('It does not: No one yet');
    expect(boundedCard).not.toMatch(/[\u0000\u202e]/u);
    expect(boundedCard.length).toBeLessThanOrEqual(4_096);
  });

  it('appends settlement points and the top five leaderboard rows to a final result', () => {
    const leaderboard = Array.from({ length: 6 }, (_, index) => ({
      username: `player_${index}`,
      displayName: `Player ${index}`,
      points: 60 - index * 10,
      wins: 6 - index,
      losses: index,
    }));
    const receipt = receiptCardText({
      ...RECEIPT_INPUT,
      points: {
        winnerCount: 1,
        missCount: 1,
        winners: [{ username: 'alice_7', displayName: 'Alice' }],
        misses: [{ username: null, displayName: 'Bob' }],
        leaderboard,
      },
    });

    expect(receipt).toContain(
      ['Points', 'Winners (+10 points): @alice_7', 'Misses (+0 points): Bob'].join('\n'),
    );
    expect(receipt).toContain('1st. @player_0 - 60 points, 6 wins, 0 losses, 100% accuracy');
    expect(receipt).toContain('5th. @player_4 - 20 points, 2 wins, 4 losses, 33% accuracy');
    expect(receipt).not.toContain('@player_5');
    expect(receipt).toContain('💠 Dee collects 0.08 SOL. (devnet)');
    expect(receipt).toContain('Receipt: https://example.test/r/abc');
  });

  it('omits points sections when points are absent or the result is void', () => {
    const withoutPoints = receiptCardText({ ...RECEIPT_INPUT, outcome: 'claim_lost' });
    const voidReceipt = receiptCardText({
      ...RECEIPT_INPUT,
      outcome: 'void',
      points: {
        winnerCount: 1,
        missCount: 0,
        winners: [{ username: 'alice_7', displayName: 'Alice' }],
        misses: [{ username: null, displayName: 'Bob' }],
        leaderboard: [
          { username: 'alice_7', displayName: 'Alice', points: 10, wins: 1, losses: 0 },
        ],
      },
    });

    for (const text of [withoutPoints, voidReceipt]) {
      expect(text).not.toContain('\nPoints\n');
      expect(text).not.toContain('Group leaderboard');
    }
  });

  it('cards carry no fiat currency and no odds notation', () => {
    const receipt = receiptCardText({ ...RECEIPT_INPUT, isReplay: true });
    for (const text of [card, receipt]) {
      expect(text).not.toMatch(/[$£€]/);
      expect(text).not.toMatch(/\bRep\b/); // no play-money leftovers
      expect(text).not.toMatch(/\b\d+\s*\/\s*\d+\b/); // no "11/2" odds notation
    }
    expect(receipt).toContain('REPLAY');
    expect(receipt).toContain('CALLED IT');
    expect(receipt).toContain('0.08 SOL');
  });
});
