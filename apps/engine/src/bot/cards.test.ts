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
  const card = claimCardText({
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
  });

  it('claim card carries terms, feed price, SOL pots and matched %', () => {
    expect(card).toContain('France to score 2 or more goals');
    expect(card).toContain('42%');
    // Full-match multipliers derive from the feed ratio (p=0.42): back ×2.4, against ×1.7.
    expect(card).toContain('×2.4');
    expect(card).toContain('×1.7');
    expect(card).toContain('modelled price');
    expect(card).toContain('0.05 SOL'); // backing pot
    expect(card).toContain('0.03 SOL'); // against pot
    expect(card).toContain('Matched: 60%');
  });

  it('cards carry no links, fiat currency, odds notation, replay tells or em dashes', () => {
    const settled = receiptCardText({
      quotedText: 'France score twice today, easy',
      claimerName: 'Dee',
      spec: TEAM_SPEC,
      outcome: 'claim_won',
      probability: 0.42,
      provenance: 'modelled',
      payoutsLine: 'Dee collects 0.08 SOL.',
      isReplay: true,
    });
    for (const text of [card, settled]) {
      expect(text).not.toMatch(/[$£€]/);
      expect(text).not.toMatch(/\bRep\b/); // no play-money leftovers
      expect(text).not.toMatch(/\b\d+\s*\/\s*\d+\b/); // no "11/2" odds notation
      expect(text).not.toMatch(/https?:\/\//); // demo build: no receipt links
      expect(text).not.toMatch(/REPLAY|[Rr]eplay/); // every match reads as live
      expect(text).not.toContain('—'); // house style: no em dashes in chat copy
    }
    expect(settled).toContain('SETTLED');
    expect(settled).toContain('CALLED IT');
    expect(settled).toContain('0.08 SOL');
  });
});
