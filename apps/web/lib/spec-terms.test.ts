import { describe, expect, it } from 'vitest';
import type { MarketSpec } from '@calledit/market-engine';
import {
  describePeriod,
  describeTerms,
  describeTier,
  describeTrustState,
  parseMarketSpec,
  PROVENANCE_COPY,
} from './spec-terms';

const TEAM_SPEC: MarketSpec = {
  claimType: 'team_scores_n',
  fixtureId: 42,
  entityRef: { kind: 'team', participant: 1, name: 'France' },
  comparator: 'gte',
  threshold: 2,
  period: 'FT_90',
  trustTier: 'chain_proven',
};

describe('parseMarketSpec', () => {
  it('round-trips a valid spec jsonb', () => {
    const parsed = parseMarketSpec(JSON.parse(JSON.stringify(TEAM_SPEC)));
    expect(parsed).toEqual(TEAM_SPEC);
  });

  it('keeps a valid comeback anchor', () => {
    const spec: MarketSpec = {
      ...TEAM_SPEC,
      claimType: 'comeback',
      anchor: { seq: 900, scoreP1: 0, scoreP2: 1 },
    };
    expect(parseMarketSpec(JSON.parse(JSON.stringify(spec)))?.anchor).toEqual(spec.anchor);
  });

  it.each([
    ['null', null],
    ['not an object', 'match_winner'],
    ['unknown claim type', { ...TEAM_SPEC, claimType: 'first_scorer' }],
    ['missing entityRef', { ...TEAM_SPEC, entityRef: undefined }],
    ['bad comparator', { ...TEAM_SPEC, comparator: 'gt' }],
    ['bad period', { ...TEAM_SPEC, period: 'HT' }],
    ['bad trust tier', { ...TEAM_SPEC, trustTier: 'gospel' }],
    ['string threshold', { ...TEAM_SPEC, threshold: '2' }],
  ])('rejects %s', (_label, value) => {
    expect(parseMarketSpec(value)).toBeNull();
  });

  it('drops a malformed anchor instead of failing the spec', () => {
    const parsed = parseMarketSpec({ ...TEAM_SPEC, anchor: { seq: 'nope' } });
    expect(parsed).not.toBeNull();
    expect(parsed?.anchor).toBeUndefined();
  });
});

describe('describeTerms', () => {
  it('renders every claim type in plain English', () => {
    const player = {
      kind: 'player',
      normativeId: 7,
      name: 'Mbappé',
      participant: 1,
    } as const;
    expect(describeTerms({ ...TEAM_SPEC, claimType: 'match_winner' })).toBe('France to win');
    expect(describeTerms({ ...TEAM_SPEC, claimType: 'totals_ou', threshold: 3 })).toBe(
      '3 goals or more in the match',
    );
    expect(describeTerms(TEAM_SPEC)).toBe('France to score 2 goals or more');
    expect(describeTerms({ ...TEAM_SPEC, claimType: 'btts' })).toBe('Both teams to score');
    expect(
      describeTerms({
        ...TEAM_SPEC,
        claimType: 'player_scores_n',
        entityRef: player,
        threshold: 1,
      }),
    ).toBe('Mbappé to score');
    expect(
      describeTerms({
        ...TEAM_SPEC,
        claimType: 'player_scores_n',
        entityRef: player,
        threshold: 2,
      }),
    ).toBe('Mbappé to score 2 goals or more');
    expect(
      describeTerms({
        ...TEAM_SPEC,
        claimType: 'comeback',
        anchor: { seq: 12, scoreP1: 0, scoreP2: 2 },
      }),
    ).toBe('France to turn it around from 0–2 down and win');
  });

  it('handles lte/eq comparators and singular nouns', () => {
    expect(describeTerms({ ...TEAM_SPEC, claimType: 'totals_ou', comparator: 'lte' })).toBe(
      '2 goals or fewer in the match',
    );
    expect(
      describeTerms({ ...TEAM_SPEC, claimType: 'totals_ou', comparator: 'eq', threshold: 1 }),
    ).toBe('exactly 1 goal in the match');
  });
});

describe('consumer copy register', () => {
  // Compliance gate from the PRD: game-show register only — no bookie
  // vocabulary, no odds notation, no currency symbols in rendered copy.
  const BANNED_VOCABULARY = /\b(odds|bet|bets|betting|wager|stake|staking|bookie|payout|bankroll)\b|\d+\s*[/-]\s*\d+\s*(on|against)|[$£€]/i;

  it('never leaks sportsbook vocabulary', () => {
    const rendered: string[] = [
      describeTerms(TEAM_SPEC),
      describePeriod('FT'),
      describePeriod('FT_90'),
      describeTier('chain_proven').label,
      describeTier('chain_proven').blurb,
      describeTier('oracle_resolved').label,
      describeTier('oracle_resolved').blurb,
      PROVENANCE_COPY.market.label,
      PROVENANCE_COPY.market.blurb,
      PROVENANCE_COPY.modelled.label,
      PROVENANCE_COPY.modelled.blurb,
    ];
    for (const copy of rendered) {
      expect(copy).not.toMatch(BANNED_VOCABULARY);
    }
  });
});

describe('describeTrustState', () => {
  it('does not claim a pending chain proof has verified', () => {
    expect(
      describeTrustState(
        { status: 'settled', tier: 'chain_proven', proofStatus: 'pending' },
        'chain_proven',
      ).label,
    ).toBe('Chain proof not yet verified');
  });

  it('states unavailable and failed proof outcomes plainly', () => {
    expect(
      describeTrustState(
        { status: 'settled', tier: 'chain_proven', proofStatus: 'unavailable' },
        'chain_proven',
      ).label,
    ).toBe('Chain proof unavailable');
    expect(
      describeTrustState(
        { status: 'settled', tier: 'chain_proven', proofStatus: 'failed' },
        'chain_proven',
      ).label,
    ).toBe('Chain proof could not verify');
  });

  it('describes signed-feed provenance without claiming a chain proof', () => {
    expect(
      describeTrustState(
        { status: 'settled', tier: 'oracle_resolved', proofStatus: null },
        'oracle_resolved',
      ),
    ).toMatchObject({ label: 'Signed feed resolved', tone: 'sky' });
  });
});
