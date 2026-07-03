/**
 * Behavior tests for the claim-flow callback handlers, exercised through
 * dispatchCallback with an in-memory DB and a recording poster. Focus areas
 * (from the audited defects): pricing failure must not kill the flow, the
 * per-claim lock must make double-taps mint exactly one market, the TTL must
 * slide on interaction, and superseded confirm gates must lose their buttons.
 */

import { describe, expect, it } from 'vitest';
import type { Context } from 'grammy';
import { TUNABLES } from '@calledit/market-engine';
import type { MarketSpec, PriceQuote } from '@calledit/market-engine';
import { dispatchCallback } from './callbacks.js';
import { renderFallback } from './copy.js';
import type { HandlerCtx } from './context.js';
import type { PostOptions } from './poster.js';
import { readEnvelope, type ParseEnvelope } from '../pipeline/claims.js';
import type {
  ClaimRow,
  Deps,
  EngineDb,
  FixtureRow,
  GroupRow,
  MarketRow,
  OddsFetchResult,
} from '../ports.js';
import { LlmBudget } from './budget.js';

const NOW = Date.parse('2026-07-03T18:00:00.000Z');
const CHAT_ID = -100123;
const CLAIMER_ID = 7001;
const CLAIM_ID = 'a3bb189e-8bf9-3888-9912-ace4e6543002';
const FIXTURE_ID = 42;
const FUTURE_ISO = new Date(NOW + 60 * 60_000).toISOString();

function spec(overrides: Partial<MarketSpec> = {}): MarketSpec {
  return {
    claimType: 'match_winner',
    fixtureId: FIXTURE_ID,
    entityRef: { kind: 'team', participant: 1, name: 'Egypt' },
    comparator: 'gte',
    threshold: 1,
    period: 'FT_90',
    trustTier: 'oracle_resolved',
    ...overrides,
  };
}

const QUOTE: PriceQuote = {
  probability: 0.6,
  multiplier: 1.6,
  provenance: 'market',
  oddsMessageId: 'om-1',
  oddsTsMs: NOW - 1000,
};

const FIXTURE: FixtureRow = {
  fixture_id: FIXTURE_ID,
  p1_name: 'Egypt',
  p2_name: 'Ghana',
  kickoff_at: FUTURE_ISO,
  phase: 'NS',
  minute: null,
  last_seq: 0,
  score: {},
  coverage_unreliable: false,
};

const GROUP: GroupRow = {
  id: CHAT_ID,
  title: 'Sunday Legends',
  slug: 'sunday-legends',
  web_enabled: true,
  chattiness: 'nudge',
  is_admin: true,
};

function claimRow(status: ClaimRow['status'], parse: unknown = null): ClaimRow {
  return {
    id: CLAIM_ID,
    group_id: CHAT_ID,
    claimer_user_id: CLAIMER_ID,
    tg_message_id: 555,
    quoted_text: 'Egypt win this',
    status,
    classifier_confidence: 0.9,
    parse,
    expires_at: new Date(NOW + 5 * 60_000).toISOString(),
    created_at: new Date(NOW - 60_000).toISOString(),
  };
}

function clarifyEnvelope(): ParseEnvelope {
  return {
    raw: null,
    kind: 'clarify',
    question: 'in 90 minutes, or advancing?',
    options: [
      { key: '0', label: '90 minutes', spec: spec({ period: 'FT_90' }) },
      { key: '1', label: 'Advancing', spec: spec({ period: 'FT' }) },
    ],
  };
}

interface RecordedPost {
  chatId: number;
  text: string;
  options: PostOptions;
}

interface Harness {
  h: HandlerCtx;
  posts: RecordedPost[];
  strips: number[];
  patches: Array<Record<string, unknown>>;
  markets: MarketRow[];
  getClaim: () => ClaimRow;
  parseCalls: () => number;
}

interface HarnessConfig {
  claim: ClaimRow;
  fetchOdds?: () => Promise<OddsFetchResult> | OddsFetchResult;
  priceSpec?: () => PriceQuote;
  parse?: () => unknown;
  fixture?: FixtureRow | null;
  llmBudget?: number;
}

function makeHarness(config: HarnessConfig): Harness {
  let claim = { ...config.claim };
  const posts: RecordedPost[] = [];
  const strips: number[] = [];
  const patches: Array<Record<string, unknown>> = [];
  const markets: MarketRow[] = [];
  let parseCount = 0;

  const db = {
    getClaim: async (id: string) => (id === claim.id ? { ...claim } : null),
    getGroup: async (id: number) => (id === CHAT_ID ? GROUP : null),
    getUser: async (id: number) =>
      id === CLAIMER_ID ? { id, display_name: 'Dee', username: 'dee' } : null,
    updateClaim: async (_id: string, patch: Record<string, unknown>) => {
      patches.push(patch);
      claim = { ...claim, ...patch } as ClaimRow;
    },
    getFixture: async () => (config.fixture === undefined ? FIXTURE : config.fixture),
    openMarketsForGroup: async () => markets.filter((m) => m.status === 'open'),
    insertMarket: async (input: Record<string, unknown>) => {
      const market = {
        ...input,
        id: `market-${markets.length + 1}`,
        card_tg_message_id: null,
        created_at: new Date(NOW).toISOString(),
      } as unknown as MarketRow;
      markets.push(market);
      return market;
    },
    setMarketCardMessage: async () => undefined,
    positionsForMarket: async () => [],
    playersForFixture: async () => [],
  } as unknown as EngineDb;

  const deps = {
    db,
    agent: {
      parse: async () => {
        parseCount += 1;
        if (config.parse) return config.parse();
        throw new Error('parse not stubbed');
      },
    },
    engine: {
      priceSpec: () => (config.priceSpec ? config.priceSpec() : QUOTE),
      compileClaim: () => ({ kind: 'ok' as const, spec: spec() }),
    },
    tx: {
      fetchOdds: async () =>
        config.fetchOdds ? config.fetchOdds() : ({ kind: 'ok', odds: oddsInputs() } as const),
    },
    proofSubmitter: null,
    env: { WEB_BASE_URL: 'https://web.test' },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => NOW,
  } as unknown as Deps;

  const h = {
    deps,
    poster: {
      post: (chatId: number, text: string, options: PostOptions = {}) => {
        posts.push({ chatId, text, options });
      },
      editCard: () => undefined,
      stripKeyboard: (_chatId: number, messageId: number) => {
        strips.push(messageId);
      },
    },
    say: async (key: Parameters<typeof renderFallback>[0], vars = {}) =>
      renderFallback(key, vars),
    supervisor: { replayFixture: () => null },
    budget: new LlmBudget(config.llmBudget ?? 1000, () => NOW),
  } as unknown as HandlerCtx;

  return { h, posts, strips, patches, markets, getClaim: () => claim, parseCalls: () => parseCount };
}

function oddsInputs() {
  return {
    p1x2: { home: 0.6, draw: 0.25, away: 0.15 },
    totals: { line: 2.5, overProb: 0.55 },
    oddsMessageId: 'om-1',
    oddsTsMs: NOW - 1000,
  };
}

function fakeCtx(userId = CLAIMER_ID): { ctx: Context; toasts: string[] } {
  const toasts: string[] = [];
  const ctx = {
    chat: { id: CHAT_ID },
    from: { id: userId, first_name: 'Dee' },
    answerCallbackQuery: async (payload: { text: string }) => {
      toasts.push(payload.text);
    },
  } as unknown as Context;
  return { ctx, toasts };
}

function keyboardData(post: RecordedPost): string[] {
  const keyboard = post.options.keyboard;
  if (!keyboard) return [];
  return keyboard.inline_keyboard.flat().map((button) => {
    return 'callback_data' in button ? button.callback_data : '';
  });
}

describe('pricing failure keeps the flow alive (finding: price failure resets claim)', () => {
  it('keeps a clarifying claim pickable, posts a retry button, and the retry re-prices without an LLM parse', async () => {
    let fetchCalls = 0;
    const harness = makeHarness({
      claim: claimRow('clarifying', clarifyEnvelope()),
      fetchOdds: () => {
        fetchCalls += 1;
        return fetchCalls === 1
          ? ({ kind: 'transient' } as const)
          : ({ kind: 'ok', odds: oddsInputs() } as const);
      },
    });

    const first = fakeCtx();
    await dispatchCallback(harness.h, first.ctx, { t: 'option', claimId: CLAIM_ID, key: '0' });

    // Status must NOT be reset to 'nudged' — the options keyboard stays live.
    expect(harness.getClaim().status).toBe('clarifying');
    expect(harness.patches.some((patch) => patch.status === 'nudged')).toBe(false);
    // The failure post carries transient copy and a Run-it-again button for the SAME option.
    const failurePost = harness.posts.at(-1);
    expect(failurePost?.text).toBe(renderFallback('no_price'));
    expect(keyboardData(failurePost!)).toContain(`op:${CLAIM_ID}:0`);
    // The tap extended the TTL.
    expect(harness.patches.at(-1)?.expires_at).toBe(
      new Date(NOW + TUNABLES.UNCONFIRMED_CLAIM_TTL_MS).toISOString(),
    );

    // Retry the SAME button: now the odds are back and the gate must appear.
    const second = fakeCtx();
    await dispatchCallback(harness.h, second.ctx, { t: 'option', claimId: CLAIM_ID, key: '0' });

    expect(harness.getClaim().status).toBe('awaiting_confirm');
    const envelope = readEnvelope(harness.getClaim());
    expect(envelope?.chosen).toEqual(spec({ period: 'FT_90' }));
    expect(harness.posts.at(-1)?.text).toContain('is that your shout?');
    // The whole loop cost zero LLM parses.
    expect(harness.parseCalls()).toBe(0);
  });

  it('distinguishes no-odds from transient and skips the retry button when the spec is unpriceable', async () => {
    const noOdds = makeHarness({
      claim: claimRow('clarifying', clarifyEnvelope()),
      fetchOdds: () => ({ kind: 'no_odds' }) as const,
    });
    await dispatchCallback(noOdds.h, fakeCtx().ctx, { t: 'option', claimId: CLAIM_ID, key: '0' });
    expect(noOdds.posts.at(-1)?.text).toBe(renderFallback('no_line'));
    expect(keyboardData(noOdds.posts.at(-1)!)).toContain(`op:${CLAIM_ID}:0`);

    const unpriceable = makeHarness({
      claim: claimRow('clarifying', clarifyEnvelope()),
      priceSpec: () => {
        throw new Error('player not yet bound to a side');
      },
    });
    await dispatchCallback(unpriceable.h, fakeCtx().ctx, {
      t: 'option',
      claimId: CLAIM_ID,
      key: '0',
    });
    expect(unpriceable.posts.at(-1)?.text).toBe(renderFallback('unpriceable'));
    // Retrying an unpriceable spec is futile — no retry button.
    expect(unpriceable.posts.at(-1)?.options.keyboard).toBeUndefined();
    expect(unpriceable.getClaim().status).toBe('clarifying');
  });

  it('maps the typed missing-input pricer error to the honest no-line copy', async () => {
    const missingInput = new Error('priceSpec: 1X2 probabilities required to price match_winner');
    missingInput.name = 'MissingOddsInputError';
    const harness = makeHarness({
      claim: claimRow('clarifying', clarifyEnvelope()),
      priceSpec: () => {
        throw missingInput;
      },
    });
    await dispatchCallback(harness.h, fakeCtx().ctx, { t: 'option', claimId: CLAIM_ID, key: '0' });
    expect(harness.posts.at(-1)?.text).toBe(renderFallback('no_line'));
  });
});

describe('confirm double-tap (finding: two markets for one claim)', () => {
  function confirmedEnvelope(): ParseEnvelope {
    return {
      ...clarifyEnvelope(),
      chosen: spec({ period: 'FT_90' }),
      quote: {
        probability: QUOTE.probability,
        multiplier: QUOTE.multiplier,
        provenance: QUOTE.provenance,
        oddsMessageId: QUOTE.oddsMessageId,
        oddsTsMs: QUOTE.oddsTsMs,
      },
      gateMessageId: 888,
    };
  }

  it('mints exactly one market for two concurrent confirm taps', async () => {
    const harness = makeHarness({ claim: claimRow('awaiting_confirm', confirmedEnvelope()) });
    const tapA = fakeCtx();
    const tapB = fakeCtx();
    await Promise.all([
      dispatchCallback(harness.h, tapA.ctx, { t: 'confirm', claimId: CLAIM_ID }),
      dispatchCallback(harness.h, tapB.ctx, { t: 'confirm', claimId: CLAIM_ID }),
    ]);

    expect(harness.markets).toHaveLength(1);
    expect(harness.getClaim().status).toBe('confirmed');
    // The loser of the race gets the in-flight toast, not a false 'Locked'.
    expect([...tapA.toasts, ...tapB.toasts]).toContain(renderFallback('hold_on'));
    // The winning tap was acked only after the mint.
    expect([...tapA.toasts, ...tapB.toasts]).toContain('Locked. 🎙');
    // The minted gate's keyboard was retired.
    expect(harness.strips).toContain(888);
  });

  it('answers stale (no second market) for a confirm tap after the mint', async () => {
    const harness = makeHarness({ claim: claimRow('awaiting_confirm', confirmedEnvelope()) });
    await dispatchCallback(harness.h, fakeCtx().ctx, { t: 'confirm', claimId: CLAIM_ID });
    const late = fakeCtx();
    await dispatchCallback(harness.h, late.ctx, { t: 'confirm', claimId: CLAIM_ID });
    expect(harness.markets).toHaveLength(1);
    expect(late.toasts).toContain(renderFallback('stale'));
  });

  it('treats a fixture-lookup miss as transient instead of expiring the claim', async () => {
    const harness = makeHarness({
      claim: claimRow('awaiting_confirm', confirmedEnvelope()),
      fixture: null,
    });
    const tap = fakeCtx();
    await dispatchCallback(harness.h, tap.ctx, { t: 'confirm', claimId: CLAIM_ID });
    expect(harness.markets).toHaveLength(0);
    expect(harness.getClaim().status).toBe('awaiting_confirm');
    expect(harness.patches.some((patch) => patch.status === 'expired')).toBe(false);
    expect(tap.toasts).toContain(renderFallback('hiccup'));
  });
});

describe('prove flow (findings: double parse, stranded clarifying, TTL)', () => {
  it('runs a single LLM parse for two concurrent prove taps', async () => {
    const harness = makeHarness({
      claim: claimRow('nudged'),
      parse: () => {
        throw new Error('llm exploded');
      },
    });
    const tapA = fakeCtx();
    const tapB = fakeCtx();
    await Promise.all([
      dispatchCallback(harness.h, tapA.ctx, { t: 'prove', claimId: CLAIM_ID }),
      dispatchCallback(harness.h, tapB.ctx, { t: 'prove', claimId: CLAIM_ID }),
    ]);
    expect(harness.parseCalls()).toBe(1);
    expect([...tapA.toasts, ...tapB.toasts]).toContain(renderFallback('hold_on'));
  });

  it('restores a retryable prove button when the parse infrastructure blinks', async () => {
    const harness = makeHarness({
      claim: claimRow('nudged'),
      parse: () => {
        throw new Error('llm exploded');
      },
    });
    await dispatchCallback(harness.h, fakeCtx().ctx, { t: 'prove', claimId: CLAIM_ID });
    // Not stranded in 'clarifying', not falsely 'declined' — back to 'nudged'.
    expect(harness.getClaim().status).toBe('nudged');
    expect(harness.posts.at(-1)?.text).toBe(renderFallback('prove_retry'));
  });

  it('meters the prove parse behind the LLM budget', async () => {
    const harness = makeHarness({ claim: claimRow('nudged'), llmBudget: 0 });
    const tap = fakeCtx();
    await dispatchCallback(harness.h, tap.ctx, { t: 'prove', claimId: CLAIM_ID });
    expect(harness.parseCalls()).toBe(0);
    expect(harness.getClaim().status).toBe('nudged');
    expect(tap.toasts).toContain(renderFallback('budget_spent'));
  });

  it('extends the TTL on the prove tap and again at the confirm gate', async () => {
    const extendedIso = new Date(NOW + TUNABLES.UNCONFIRMED_CLAIM_TTL_MS).toISOString();
    const rawParse = {
      claimType: 'match_winner',
      fixtureId: FIXTURE_ID,
      entityName: 'Egypt',
      entityKind: 'team',
      comparator: 'gte',
      threshold: 1,
      period: 'FT_90',
      unresolved: null,
    };
    const harness = makeHarness({ claim: claimRow('nudged'), parse: () => rawParse });
    await dispatchCallback(harness.h, fakeCtx().ctx, { t: 'prove', claimId: CLAIM_ID });

    const clarifyingPatch = harness.patches.find((patch) => patch.status === 'clarifying');
    expect(clarifyingPatch?.expires_at).toBe(extendedIso);
    const gatePatch = harness.patches.find((patch) => patch.status === 'awaiting_confirm');
    expect(gatePatch?.expires_at).toBe(extendedIso);
  });
});

describe('confirm-gate switching (finding: old gate mints new terms)', () => {
  it('strips the superseded gate keyboard when the claimer switches options', async () => {
    const harness = makeHarness({ claim: claimRow('clarifying', clarifyEnvelope()) });

    await dispatchCallback(harness.h, fakeCtx().ctx, { t: 'option', claimId: CLAIM_ID, key: '0' });
    const gateA = harness.posts.at(-1)!;
    expect(gateA.text).toContain('is that your shout?');
    await gateA.options.onSent?.(111);
    expect(readEnvelope(harness.getClaim())?.gateMessageId).toBe(111);

    await dispatchCallback(harness.h, fakeCtx().ctx, { t: 'option', claimId: CLAIM_ID, key: '1' });
    // The old gate's confirm/decline buttons were removed.
    expect(harness.strips).toContain(111);
    const gateB = harness.posts.at(-1)!;
    await gateB.options.onSent?.(222);
    const envelope = readEnvelope(harness.getClaim());
    expect(envelope?.gateMessageId).toBe(222);
    expect(envelope?.chosen).toEqual(spec({ period: 'FT' }));
  });
});
