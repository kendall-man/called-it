import { describe, expect, it } from 'vitest';
import type { MarketSpec } from '@calledit/market-engine';
import {
  claimCardText,
  describeTerms,
  formatMultiplier,
  formatProbabilityPct,
  receiptCardText,
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

describe('formatters', () => {
  it('renders multipliers as ×N Rep style, never odds notation', () => {
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
  const card = claimCardText({
    quotedText: 'France score twice today, easy',
    claimerName: 'Dee',
    spec: TEAM_SPEC,
    status: 'open',
    probability: 0.42,
    multiplier: 2.4,
    provenance: 'modelled',
    back: { count: 2, totalRep: 150 },
    doubt: { count: 1, totalRep: 100 },
    isReplay: false,
    receiptUrl: 'https://example.test/r/abc',
    tableUrl: 'https://example.test/g/slug',
  });

  it('claim card carries terms, price, tallies, and both links', () => {
    expect(card).toContain('France to score 2 or more goals');
    expect(card).toContain('42%');
    expect(card).toContain('×2.4 Rep');
    expect(card).toContain('modelled price');
    expect(card).toContain('https://example.test/r/abc');
    expect(card).toContain('https://example.test/g/slug');
  });

  it('cards avoid sportsbook vocabulary and currency symbols', () => {
    const receipt = receiptCardText({
      quotedText: 'France score twice today, easy',
      claimerName: 'Dee',
      spec: TEAM_SPEC,
      outcome: 'claim_won',
      probability: 0.42,
      multiplier: 2.4,
      provenance: 'modelled',
      payoutsLine: 'Dee collects 240 Rep.',
      isReplay: true,
      receiptUrl: 'https://example.test/r/abc',
    });
    for (const text of [card, receipt]) {
      expect(text).not.toMatch(/[$£€]/);
      expect(text).not.toMatch(/\b(odds|bet|wager|bookie|slip|stake)\b/i);
      expect(text).not.toMatch(/\b\d+\s*\/\s*\d+\b/);
    }
    expect(receipt).toContain('REPLAY');
    expect(receipt).toContain('CALLED IT');
  });
});
