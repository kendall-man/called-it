import { describe, expect, it } from 'vitest';
import { compileClaim } from './compile.js';
import type { ClaimType, CompileResult, MarketSpec } from './types.js';
import { CLAIM_TYPES } from './types.js';
import {
  FIXTURE_ID,
  KICKOFF_MS,
  P1_NAME,
  P2_NAME,
  PLAYER_MBAPPE,
  PLAYER_MESSI,
  T0,
  assertCleanCopy,
  mkCtx,
  mkParse,
} from './testkit.js';

function expectReject(
  result: CompileResult,
  reason: string,
): asserts result is Extract<CompileResult, { kind: 'reject' }> {
  expect(result.kind).toBe('reject');
  if (result.kind === 'reject') expect(result.reason).toBe(reason);
}

function expectOk(
  result: CompileResult,
): asserts result is Extract<CompileResult, { kind: 'ok' }> {
  expect(result.kind).toBe('ok');
}

/** Reasonable base parses per claim type for matrix tests. */
const BASE_PARSE: Record<ClaimType, Parameters<typeof mkParse>[0]> = {
  match_winner: { claimType: 'match_winner', entityName: 'France', period: 'FT_90' },
  totals_ou: { claimType: 'totals_ou', comparator: 'gte', threshold: 2.5 },
  team_scores_n: { claimType: 'team_scores_n', entityName: 'France', threshold: 2 },
  btts: { claimType: 'btts' },
  player_scores_n: {
    claimType: 'player_scores_n',
    entityName: 'Mbappé',
    threshold: 2,
  },
  comeback: { claimType: 'comeback', entityName: 'France' },
};

/** Context in which every claim type can mint (comeback needs a live deficit). */
function mintableCtx(claimType: ClaimType) {
  if (claimType === 'comeback') {
    return mkCtx({
      fixture: {
        phase: 'H2',
        minute: 60,
        score: { p1Goals: 0, p2Goals: 1 },
        lastSeq: 12,
      },
    });
  }
  return mkCtx();
}

describe('compileClaim — matrix: every claim type', () => {
  for (const claimType of CLAIM_TYPES) {
    describe(claimType, () => {
      it('rejects with no_fixture when no fixture is grounded', () => {
        const result = compileClaim(mkParse(BASE_PARSE[claimType]), mkCtx({ fixture: null }));
        expectReject(result, 'no_fixture');
      });

      it('rejects with no_fixture on fixture id mismatch', () => {
        const result = compileClaim(
          mkParse({ ...BASE_PARSE[claimType], fixtureId: FIXTURE_ID + 1 }),
          mintableCtx(claimType),
        );
        expectReject(result, 'no_fixture');
      });

      it('rejects a monetary forfeit before anything else', () => {
        const result = compileClaim(
          mkParse({ ...BASE_PARSE[claimType], unresolved: 'loser sends $20' }),
          mintableCtx(claimType),
        );
        expectReject(result, 'monetary_forfeit');
      });

      it('rejects when coverage is flagged unreliable', () => {
        const ctx = mintableCtx(claimType);
        const result = compileClaim(mkParse(BASE_PARSE[claimType]), {
          ...ctx,
          fixture: ctx.fixture ? { ...ctx.fixture, coverageUnreliable: true } : null,
        });
        expectReject(result, 'window_closed');
      });

      it('rejects when the match is already over', () => {
        const ctx = mintableCtx(claimType);
        const result = compileClaim(mkParse(BASE_PARSE[claimType]), {
          ...ctx,
          fixture: ctx.fixture ? { ...ctx.fixture, phase: 'F', minute: null } : null,
        });
        expectReject(result, 'window_closed');
      });

      it('rejects when the match is abandoned', () => {
        const ctx = mintableCtx(claimType);
        const result = compileClaim(mkParse(BASE_PARSE[claimType]), {
          ...ctx,
          fixture: ctx.fixture ? { ...ctx.fixture, phase: 'ABD' } : null,
        });
        expectReject(result, 'window_closed');
      });
    });
  }
});

describe('compileClaim — taxonomy gate', () => {
  it('rejects a null claim type with free text as unresolvable', () => {
    const result = compileClaim(
      mkParse({ unresolved: 'france corners galore first half' }),
      mkCtx(),
    );
    expectReject(result, 'unresolvable');
  });

  it('rejects a null claim type without free text as unsupported', () => {
    const result = compileClaim(mkParse(), mkCtx());
    expectReject(result, 'unsupported_claim_type');
  });

  it('rejects a claim type outside the closed taxonomy at runtime', () => {
    const parse = mkParse({ claimType: 'first_scorer' as ClaimType });
    const result = compileClaim(parse, mkCtx());
    expectReject(result, 'unsupported_claim_type');
  });
});

describe('compileClaim — monetary forfeit deny list', () => {
  const monetary = [
    'loser sends $20',
    'loser pays 20 bucks',
    '£50 says they lose',
    'venmo me if I win',
    'loser buys dinner',
    'you owe me a tenner',
    'settle in USDC',
  ];
  for (const text of monetary) {
    it(`refuses: "${text}"`, () => {
      const result = compileClaim(
        mkParse({ claimType: 'btts', unresolved: text }),
        mkCtx(),
      );
      expectReject(result, 'monetary_forfeit');
      if (result.kind === 'reject') {
        expect(assertCleanCopy(result.message)).toEqual([]);
      }
    });
  }

  it('does not trip on harmless banter', () => {
    const result = compileClaim(
      mkParse({ claimType: 'btts', unresolved: 'both nets bulging tonight' }),
      mkCtx(),
    );
    expectOk(result);
  });
});

describe('compileClaim — match_winner', () => {
  it('clarifies "in 90 or advancing" when the period is ambiguous', () => {
    const result = compileClaim(
      mkParse({ claimType: 'match_winner', entityName: 'France' }),
      mkCtx(),
    );
    expect(result.kind).toBe('clarify');
    if (result.kind !== 'clarify') return;
    expect(result.options).toHaveLength(2);
    const periods = result.options.map((o) => o.spec.period).sort();
    expect(periods).toEqual(['FT', 'FT_90']);
    for (const option of result.options) {
      expect(option.spec.claimType).toBe('match_winner');
      expect(option.spec.entityRef).toEqual({
        kind: 'team',
        participant: 1,
        name: P1_NAME,
      });
      expect(option.spec.trustTier).toBe('chain_proven');
      expect(assertCleanCopy(option.label)).toEqual([]);
    }
    expect(assertCleanCopy(result.question)).toEqual([]);
  });

  it('compiles directly when the period is explicit', () => {
    const result = compileClaim(
      mkParse({ claimType: 'match_winner', entityName: 'argentina', period: 'FT' }),
      mkCtx(),
    );
    expectOk(result);
    if (result.kind !== 'ok') return;
    expect(result.spec.entityRef).toEqual({
      kind: 'team',
      participant: 2,
      name: P2_NAME,
    });
    expect(result.spec.period).toBe('FT');
    expect(result.spec.trustTier).toBe('chain_proven');
  });

  it('resolves team names with diacritics and partial matches', () => {
    const ctx = mkCtx({ fixture: { p2Name: 'Côte d’Ivoire' } });
    const result = compileClaim(
      mkParse({ claimType: 'match_winner', entityName: 'cote d’ivoire', period: 'FT_90' }),
      ctx,
    );
    expectOk(result);
  });

  it('rejects an unknown team', () => {
    const result = compileClaim(
      mkParse({ claimType: 'match_winner', entityName: 'Brazil', period: 'FT_90' }),
      mkCtx(),
    );
    expectReject(result, 'unknown_entity');
  });

  it('rejects a missing entity name', () => {
    const result = compileClaim(
      mkParse({ claimType: 'match_winner', period: 'FT_90' }),
      mkCtx(),
    );
    expectReject(result, 'unknown_entity');
  });

  it('mints in play up to the 75-minute cutoff', () => {
    const open = compileClaim(
      mkParse(BASE_PARSE.match_winner),
      mkCtx({ fixture: { phase: 'H2', minute: 75 } }),
    );
    expectOk(open);
    const closed = compileClaim(
      mkParse(BASE_PARSE.match_winner),
      mkCtx({ fixture: { phase: 'H2', minute: 76 } }),
    );
    expectReject(closed, 'window_closed');
  });

  it('does not mint during extra time', () => {
    const result = compileClaim(
      mkParse(BASE_PARSE.match_winner),
      mkCtx({ fixture: { phase: 'ET1', minute: 95 } }),
    );
    expectReject(result, 'window_closed');
  });
});

describe('compileClaim — totals_ou', () => {
  it('compiles a half-goal line as stated', () => {
    const result = compileClaim(mkParse(BASE_PARSE.totals_ou), mkCtx());
    expectOk(result);
    if (result.kind !== 'ok') return;
    expect(result.spec.threshold).toBe(2.5);
    expect(result.spec.comparator).toBe('gte');
    expect(result.spec.period).toBe('FT_90');
  });

  it('clarifies the line when no number was parsed', () => {
    const result = compileClaim(
      mkParse({ claimType: 'totals_ou', comparator: 'gte' }),
      mkCtx(),
    );
    expect(result.kind).toBe('clarify');
    if (result.kind !== 'clarify') return;
    expect(result.options.map((o) => o.spec.threshold)).toEqual([1.5, 2.5, 3.5]);
    for (const option of result.options) {
      expect(option.spec.claimType).toBe('totals_ou');
      expect(assertCleanCopy(option.label)).toEqual([]);
    }
  });

  it('rejects quarter lines as out_of_range', () => {
    const result = compileClaim(
      mkParse({ claimType: 'totals_ou', threshold: 2.25 }),
      mkCtx(),
    );
    expectReject(result, 'out_of_range');
  });

  it('rejects "exactly N.5 goals" — eq needs an integer threshold', () => {
    // An eq claim on a half-goal line is unwinnable (goal tallies are whole
    // numbers); it must never compile into a mintable spec.
    const result = compileClaim(
      mkParse({ claimType: 'totals_ou', comparator: 'eq', threshold: 2.5 }),
      mkCtx(),
    );
    expectReject(result, 'out_of_range');
  });

  it('rejects lines outside the sane band', () => {
    expectReject(
      compileClaim(mkParse({ claimType: 'totals_ou', threshold: 0 }), mkCtx()),
      'out_of_range',
    );
    expectReject(
      compileClaim(mkParse({ claimType: 'totals_ou', threshold: 12.5 }), mkCtx()),
      'out_of_range',
    );
  });
});

describe('compileClaim — team_scores_n', () => {
  it('defaults the threshold to 1 goal', () => {
    const result = compileClaim(
      mkParse({ claimType: 'team_scores_n', entityName: 'France' }),
      mkCtx(),
    );
    expectOk(result);
    if (result.kind !== 'ok') return;
    expect(result.spec.threshold).toBe(1);
    expect(result.spec.comparator).toBe('gte');
  });

  it('rejects non-integer goal counts', () => {
    const result = compileClaim(
      mkParse({ claimType: 'team_scores_n', entityName: 'France', threshold: 2.5 }),
      mkCtx(),
    );
    expectReject(result, 'out_of_range');
  });

  it('rejects zero and absurd goal counts', () => {
    expectReject(
      compileClaim(
        mkParse({ claimType: 'team_scores_n', entityName: 'France', threshold: 0 }),
        mkCtx(),
      ),
      'out_of_range',
    );
    expectReject(
      compileClaim(
        mkParse({ claimType: 'team_scores_n', entityName: 'France', threshold: 11 }),
        mkCtx(),
      ),
      'out_of_range',
    );
  });

  it('supports eq claims ("exactly 2")', () => {
    const result = compileClaim(
      mkParse({
        claimType: 'team_scores_n',
        entityName: 'Argentina',
        comparator: 'eq',
        threshold: 2,
      }),
      mkCtx(),
    );
    expectOk(result);
    if (result.kind !== 'ok') return;
    expect(result.spec.comparator).toBe('eq');
  });
});

describe('compileClaim — btts', () => {
  it('compiles with forced comparator gte / threshold 1', () => {
    const result = compileClaim(mkParse({ claimType: 'btts' }), mkCtx());
    expectOk(result);
    if (result.kind !== 'ok') return;
    expect(result.spec.comparator).toBe('gte');
    expect(result.spec.threshold).toBe(1);
    expect(result.spec.trustTier).toBe('chain_proven');
  });
});

describe('compileClaim — comeback', () => {
  it('rejects pre-match ("no deficit yet")', () => {
    const result = compileClaim(mkParse(BASE_PARSE.comeback), mkCtx());
    expectReject(result, 'window_closed');
  });

  it('rejects while level', () => {
    const result = compileClaim(
      mkParse(BASE_PARSE.comeback),
      mkCtx({ fixture: { phase: 'H2', minute: 50, score: { p1Goals: 1, p2Goals: 1 } } }),
    );
    expectReject(result, 'window_closed');
  });

  it('rejects while leading', () => {
    const result = compileClaim(
      mkParse(BASE_PARSE.comeback),
      mkCtx({ fixture: { phase: 'H2', minute: 50, score: { p1Goals: 2, p2Goals: 1 } } }),
    );
    expectReject(result, 'window_closed');
  });

  it('anchors the claim-time seq and score while trailing', () => {
    const result = compileClaim(
      mkParse(BASE_PARSE.comeback),
      mkCtx({
        fixture: {
          phase: 'H2',
          minute: 55,
          score: { p1Goals: 0, p2Goals: 2 },
          lastSeq: 37,
        },
      }),
    );
    expectOk(result);
    if (result.kind !== 'ok') return;
    expect(result.spec.anchor).toEqual({ seq: 37, scoreP1: 0, scoreP2: 2 });
    expect(result.spec.claimType).toBe('comeback');
    expect(result.spec.entityRef).toEqual({
      kind: 'team',
      participant: 1,
      name: P1_NAME,
    });
  });

  it('respects the 75-minute mint cutoff', () => {
    const result = compileClaim(
      mkParse(BASE_PARSE.comeback),
      mkCtx({
        fixture: { phase: 'H2', minute: 80, score: { p1Goals: 0, p2Goals: 1 } },
      }),
    );
    expectReject(result, 'window_closed');
  });
});

describe('compileClaim — player_scores_n (verifiability negotiation)', () => {
  it('counter-offers the chain-proven team upgrade for a known player', () => {
    const result = compileClaim(mkParse(BASE_PARSE.player_scores_n), mkCtx());
    expect(result.kind).toBe('counter_offer');
    if (result.kind !== 'counter_offer') return;

    expect(result.asStated).not.toBeNull();
    const asStated = result.asStated as MarketSpec;
    expect(asStated.claimType).toBe('player_scores_n');
    expect(asStated.trustTier).toBe('oracle_resolved');
    expect(asStated.entityRef).toEqual({
      kind: 'player',
      normativeId: PLAYER_MBAPPE.normativeId,
      name: PLAYER_MBAPPE.name,
      participant: 1,
    });
    expect(asStated.threshold).toBe(2);

    expect(result.upgrade.claimType).toBe('team_scores_n');
    expect(result.upgrade.trustTier).toBe('chain_proven');
    expect(result.upgrade.entityRef).toEqual({
      kind: 'team',
      participant: 1,
      name: P1_NAME,
    });
    expect(result.upgrade.threshold).toBe(2);
    expect(result.upgrade.comparator).toBe('gte');

    expect(result.reason).toContain('team-level');
    expect(assertCleanCopy(result.reason)).toEqual([]);
  });

  it('resolves the opposing side correctly', () => {
    const result = compileClaim(
      mkParse({ claimType: 'player_scores_n', entityName: 'messi', threshold: 1 }),
      mkCtx(),
    );
    expect(result.kind).toBe('counter_offer');
    if (result.kind !== 'counter_offer') return;
    expect(result.upgrade.entityRef).toEqual({
      kind: 'team',
      participant: 2,
      name: P2_NAME,
    });
  });

  it('books as stated when the player side is not yet bound', () => {
    const result = compileClaim(
      mkParse(BASE_PARSE.player_scores_n),
      mkCtx({
        knownPlayers: [{ ...PLAYER_MBAPPE, participant: null }],
      }),
    );
    expectOk(result);
    if (result.kind !== 'ok') return;
    expect(result.spec.claimType).toBe('player_scores_n');
    expect(result.spec.trustTier).toBe('oracle_resolved');
    expect(result.spec.entityRef.participant).toBeNull();
  });

  it('declines an unknown player in character', () => {
    const result = compileClaim(
      mkParse({ claimType: 'player_scores_n', entityName: 'Haaland', threshold: 1 }),
      mkCtx(),
    );
    expectReject(result, 'unknown_entity');
    if (result.kind === 'reject') {
      expect(result.message).toContain('lineups');
    }
  });

  it('is pre-kickoff only — rejects once the clock passes kickoff', () => {
    const result = compileClaim(
      mkParse(BASE_PARSE.player_scores_n),
      mkCtx({ nowMs: KICKOFF_MS + 1 }),
    );
    expectReject(result, 'window_closed');
  });

  it('is pre-kickoff only — rejects once the match is live', () => {
    const result = compileClaim(
      mkParse(BASE_PARSE.player_scores_n),
      mkCtx({ fixture: { phase: 'H1', minute: 5 } }),
    );
    expectReject(result, 'window_closed');
  });

  it('rejects player goal counts outside the sane band', () => {
    expectReject(
      compileClaim(
        mkParse({ claimType: 'player_scores_n', entityName: 'Mbappé', threshold: 6 }),
        mkCtx(),
      ),
      'out_of_range',
    );
    expectReject(
      compileClaim(
        mkParse({ claimType: 'player_scores_n', entityName: 'Mbappé', threshold: 1.5 }),
        mkCtx(),
      ),
      'out_of_range',
    );
  });
});

describe('compileClaim — consumer copy stays in the game-show register', () => {
  it('never leaks bookie vocabulary, odds notation, or currency symbols', () => {
    const results: CompileResult[] = [
      compileClaim(mkParse({ claimType: 'match_winner', entityName: 'France' }), mkCtx()),
      compileClaim(mkParse({ claimType: 'totals_ou' }), mkCtx()),
      compileClaim(mkParse(BASE_PARSE.player_scores_n), mkCtx()),
      compileClaim(mkParse({ unresolved: 'loser sends $50' }), mkCtx()),
      compileClaim(mkParse({ claimType: 'comeback', entityName: 'France' }), mkCtx()),
      compileClaim(mkParse(), mkCtx({ fixture: null })),
      compileClaim(mkParse({ claimType: 'player_scores_n', entityName: 'Nobody' }), mkCtx()),
      compileClaim(
        mkParse({ claimType: 'team_scores_n', entityName: 'France', threshold: 99 }),
        mkCtx(),
      ),
    ];
    for (const result of results) {
      const texts: string[] = [];
      if (result.kind === 'reject') texts.push(result.message);
      if (result.kind === 'clarify') {
        texts.push(result.question, ...result.options.map((o) => o.label));
      }
      if (result.kind === 'counter_offer') texts.push(result.reason);
      for (const text of texts) {
        expect(assertCleanCopy(text), `dirty copy: "${text}"`).toEqual([]);
      }
    }
  });
});
