/**
 * quoteSpec's failure taxonomy (transient vs no-odds vs unpriceable must not
 * collapse) and proveClaim's never-throw contract (infrastructure blips come
 * back 'retryable' instead of stranding the claim in 'clarifying').
 */

import { describe, expect, it } from 'vitest';
import type { CompileContext, MarketSpec, PriceQuote, RawClaimParse } from '@calledit/market-engine';
import { proveClaim, quoteSpec } from './claims.js';
import type { ClaimRow, Deps, FixtureRow, OddsFetchResult } from '../ports.js';

const NOW = Date.parse('2026-07-03T18:00:00.000Z');
const FIXTURE_ID = 42;

const SPEC: MarketSpec = {
  claimType: 'match_winner',
  fixtureId: FIXTURE_ID,
  entityRef: { kind: 'team', participant: 1, name: 'Egypt' },
  comparator: 'gte',
  threshold: 1,
  period: 'FT_90',
  trustTier: 'oracle_resolved',
};

const QUOTE: PriceQuote = {
  probability: 0.6,
  multiplier: 1.6,
  provenance: 'market',
  oddsMessageId: 'om-1',
  oddsTsMs: NOW,
};

const FIXTURE: FixtureRow = {
  fixture_id: FIXTURE_ID,
  p1_name: 'Egypt',
  p2_name: 'Ghana',
  kickoff_at: new Date(NOW + 60 * 60_000).toISOString(),
  phase: 'NS',
  minute: null,
  last_seq: 0,
  score: {},
  coverage_unreliable: false,
};

const NOOP_LOG = { info: () => undefined, warn: () => undefined, error: () => undefined };

interface StubConfig {
  fetchOdds?: () => OddsFetchResult;
  priceSpec?: () => PriceQuote;
  getFixture?: () => Promise<FixtureRow | null>;
  parse?: () => unknown;
  compileClaim?: () => unknown;
}

function makeDeps(config: StubConfig = {}): Deps {
  return {
    db: {
      getFixture: config.getFixture ?? (async () => FIXTURE),
      playersForFixture: async () => [],
    },
    agent: {
      parse: async () => {
        if (config.parse) return config.parse();
        throw new Error('parse not stubbed');
      },
    },
    engine: {
      priceSpec: () => (config.priceSpec ? config.priceSpec() : QUOTE),
      compileClaim: () =>
        config.compileClaim ? config.compileClaim() : { kind: 'ok', spec: SPEC },
    },
    tx: {
      fetchOdds: async () =>
        config.fetchOdds
          ? config.fetchOdds()
          : ({
              kind: 'ok',
              odds: { p1x2: null, totals: null, oddsMessageId: 'om-1', oddsTsMs: NOW },
            } as const),
    },
    proofSubmitter: null,
    env: {},
    log: NOOP_LOG,
    now: () => NOW,
  } as unknown as Deps;
}

const CLAIM: ClaimRow = {
  id: 'a3bb189e-8bf9-3888-9912-ace4e6543002',
  group_id: -100123,
  claimer_user_id: 7001,
  tg_message_id: 555,
  quoted_text: 'Egypt win this',
  status: 'clarifying',
  classifier_confidence: 0.9,
  parse: null,
  expires_at: new Date(NOW + 5 * 60_000).toISOString(),
  created_at: new Date(NOW - 60_000).toISOString(),
};

describe('quoteSpec failure taxonomy', () => {
  it('passes through transient and no-odds fetch results', async () => {
    const transient = await quoteSpec(makeDeps({ fetchOdds: () => ({ kind: 'transient' }) }), SPEC);
    expect(transient).toEqual({ kind: 'transient' });
    const noOdds = await quoteSpec(makeDeps({ fetchOdds: () => ({ kind: 'no_odds' }) }), SPEC);
    expect(noOdds).toEqual({ kind: 'no_odds' });
  });

  it('treats a compile-context DB failure as transient, not unpriceable', async () => {
    const deps = makeDeps({
      getFixture: async () => {
        throw new Error('supabase blinked');
      },
    });
    expect(await quoteSpec(deps, SPEC)).toEqual({ kind: 'transient' });
  });

  it('maps the typed missing-input error to no_odds and other pricer throws to unpriceable', async () => {
    const missing = new Error('priceSpec: 1X2 probabilities required to price match_winner');
    missing.name = 'MissingOddsInputError';
    const noLine = await quoteSpec(
      makeDeps({
        priceSpec: () => {
          throw missing;
        },
      }),
      SPEC,
    );
    expect(noLine).toEqual({ kind: 'no_odds' });

    const structural = await quoteSpec(
      makeDeps({
        priceSpec: () => {
          throw new Error('player not yet bound to a side');
        },
      }),
      SPEC,
    );
    expect(structural).toMatchObject({ kind: 'unpriceable' });
  });

  it('uses the nearest earlier line when replay odds are temporarily suspended', async () => {
    const requestedAsOf: Array<number | undefined> = [];
    const deps = makeDeps();
    deps.tx.fetchOdds = async (_fixtureId, asOfMs) => {
      requestedAsOf.push(asOfMs);
      return {
        kind: 'ok',
        odds: {
          p1x2: requestedAsOf.length === 1
            ? null
            : { home: 0.6, draw: 0.25, away: 0.15 },
          totals: null,
          oddsMessageId: `om-${requestedAsOf.length}`,
          oddsTsMs: asOfMs ?? null,
        },
      };
    };
    deps.engine.priceSpec = (_spec, odds) => {
      if (odds.p1x2 === null) {
        const missing = new Error('1X2 temporarily suspended');
        missing.name = 'MissingOddsInputError';
        throw missing;
      }
      return { ...QUOTE, oddsMessageId: odds.oddsMessageId, oddsTsMs: odds.oddsTsMs };
    };

    const result = await quoteSpec(deps, SPEC, NOW);

    expect(result).toEqual({
      kind: 'ok',
      quote: { ...QUOTE, oddsMessageId: 'om-2', oddsTsMs: NOW - 30_000 },
    });
    expect(requestedAsOf).toEqual([NOW, NOW - 30_000]);
  });

  it('returns the quote on success', async () => {
    expect(await quoteSpec(makeDeps(), SPEC)).toEqual({ kind: 'ok', quote: QUOTE });
  });
});

describe('proveClaim never-throw contract', () => {
  const RAW: RawClaimParse = {
    claimType: 'match_winner',
    fixtureId: FIXTURE_ID,
    entityName: 'Egypt',
    entityKind: 'team',
    comparator: 'gte',
    threshold: 1,
    period: 'FT_90',
    unresolved: null,
  };

  it('returns retryable when the agent parse throws', async () => {
    const deps = makeDeps({
      parse: () => {
        throw new Error('llm exploded');
      },
    });
    expect(await proveClaim(deps, CLAIM)).toEqual({ kind: 'retryable' });
  });

  it('returns retryable when the compile-context DB read throws after the parse', async () => {
    let fixtureCalls = 0;
    const deps = makeDeps({
      parse: () => RAW,
      getFixture: async () => {
        fixtureCalls += 1;
        throw new Error('supabase blinked');
      },
    });
    expect(await proveClaim(deps, CLAIM)).toEqual({ kind: 'retryable' });
    expect(fixtureCalls).toBeGreaterThan(0);
  });

  it('still returns a terminal reject when the compiler says no', async () => {
    const deps = makeDeps({
      parse: () => RAW,
      compileClaim: () => ({ kind: 'reject', message: 'Not one I can settle.' }),
    });
    expect(await proveClaim(deps, CLAIM)).toEqual({
      kind: 'reject',
      message: 'Not one I can settle.',
    });
  });

  it('returns an envelope for a clean compile', async () => {
    const deps = makeDeps({ parse: () => RAW });
    const outcome = await proveClaim(deps, CLAIM);
    expect(outcome.kind).toBe('envelope');
  });

  type CompileCapture = { compileClaim: (raw: { fixtureId: number | null }) => unknown };

  it('pins an ambiguous (null-fixture) parse to the replay fixture', async () => {
    const REPLAY_FIXTURE = 18202701;
    const deps = makeDeps({ parse: () => ({ ...RAW, fixtureId: null, unresolved: 'which match?' }) });
    let compiledFixtureId: number | null | undefined;
    (deps.engine as unknown as CompileCapture).compileClaim = (raw) => {
      compiledFixtureId = raw.fixtureId;
      return { kind: 'ok', spec: SPEC };
    };
    const outcome = await proveClaim(deps, CLAIM, REPLAY_FIXTURE);
    expect(compiledFixtureId).toBe(REPLAY_FIXTURE); // null was overridden to the replay fixture
    expect(outcome.kind).toBe('envelope');
  });

  it('compiles a completed fixture against group-scoped replay state and clock', async () => {
    // Given a durable final fixture and its virtual in-play replay snapshot
    const replayNowMs = Date.parse(FIXTURE.kickoff_at!) + 12 * 60_000;
    const replayFixture: FixtureRow = {
      ...FIXTURE,
      phase: 'H1',
      minute: 12,
      last_seq: 120,
      score: { p1: { goals: 1 }, p2: { goals: 0 } },
    };
    let durableReads = 0;
    let parseContext: CompileContext | undefined;
    let compileContext: CompileContext | undefined;
    const deps = makeDeps({
      getFixture: async () => {
        durableReads += 1;
        return { ...FIXTURE, phase: 'F', minute: 90 };
      },
    });
    (deps.agent as unknown as {
      parse(text: string, context: CompileContext): Promise<RawClaimParse>;
    }).parse = async (_text, context) => {
      parseContext = context;
      return RAW;
    };
    (deps.engine as unknown as {
      compileClaim(raw: RawClaimParse, context: CompileContext): unknown;
    }).compileClaim = (_raw, context) => {
      compileContext = context;
      return { kind: 'ok', spec: SPEC };
    };

    // When the completed match is proved inside a replay
    const outcome = await proveClaim(deps, CLAIM, FIXTURE_ID, {
      fixture: replayFixture,
      nowMs: replayNowMs,
    });

    // Then neither parse nor compile sees the durable final state
    expect(outcome.kind).toBe('envelope');
    expect(parseContext).toMatchObject({ nowMs: replayNowMs, fixture: { phase: 'H1', minute: 12 } });
    expect(compileContext).toMatchObject({ nowMs: replayNowMs, fixture: { phase: 'H1', minute: 12 } });
    expect(durableReads).toBe(0);
  });

  it('leaves the parsed fixture untouched when no replay pin is given', async () => {
    const deps = makeDeps({ parse: () => RAW });
    let compiledFixtureId: number | null | undefined;
    (deps.engine as unknown as CompileCapture).compileClaim = (raw) => {
      compiledFixtureId = raw.fixtureId;
      return { kind: 'ok', spec: SPEC };
    };
    await proveClaim(deps, CLAIM);
    expect(compiledFixtureId).toBe(FIXTURE_ID);
  });
});
