/**
 * Claim-flow callbacks exercised through dispatchCallback with an in-memory
 * DB, a stubbed wager module, and a recording poster. The suite covers owner
 * consent and deterministic clarify/mint behavior.
 */

// allow: SIZE_OK - base pure LOC 563; only feature delta is the typed/bounded point-method test stub needed by EngineDb/card refresh.
import { describe, expect, it } from 'vitest';
import type { Context } from 'grammy';
import { TUNABLES } from '@calledit/market-engine';
import type { MarketSpec, PriceQuote } from '@calledit/market-engine';
import { dispatchCallback } from './callbacks.js';
import { renderFallback } from './copy.js';
import type { HandlerCtx } from './context.js';
import type { PostOptions } from './poster.js';
import { type ParseEnvelope } from '../pipeline/claims.js';
import { createPointMethodStubs } from '../points/point-methods.test-support.js';
import type { LogFields } from '../log.js';
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
const OTHER_ID = 7002;
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

interface RecordedLog {
  readonly event: string;
  readonly fields: LogFields | undefined;
}

interface Harness {
  h: HandlerCtx;
  posts: RecordedPost[];
  patches: Array<Record<string, unknown>>;
  markets: MarketRow[];
  settlements: Array<Record<string, unknown>>;
  strippedKeyboardMessageIds: number[];
  logs: readonly RecordedLog[];
  getClaim: () => ClaimRow;
  parseCalls: () => number;
  setNow: (nowMs: number) => void;
}

interface HarnessConfig {
  claim: ClaimRow;
  fetchOdds?: () => Promise<OddsFetchResult> | OddsFetchResult;
  priceSpec?: () => PriceQuote;
  parse?: () => unknown;
  fixture?: FixtureRow | null;
  llmBudget?: number;
  positions?: Array<{ state: string }>;
}

function makeHarness(config: HarnessConfig): Harness {
  let claim = { ...config.claim };
  const posts: RecordedPost[] = [];
  const patches: Array<Record<string, unknown>> = [];
  const markets: MarketRow[] = [];
  const settlements: Array<Record<string, unknown>> = [];
  const strippedKeyboardMessageIds: number[] = [];
  const logs: RecordedLog[] = [];
  let parseCount = 0;
  let now = NOW;

  const db = {
    ...createPointMethodStubs({ kind: 'empty', groupId: CHAT_ID }),
    getClaim: async (id: string) => (id === claim.id ? { ...claim } : null),
    getGroup: async (id: number) => (id === CHAT_ID ? GROUP : null),
    getUser: async (id: number) =>
      id === CLAIMER_ID ? { id, display_name: 'Dee', username: 'dee' } : { id, display_name: `U${id}`, username: null },
    updateClaim: async (_id: string, patch: Record<string, unknown>) => {
      patches.push(patch);
      claim = { ...claim, ...patch } as ClaimRow;
    },
    getFixture: async () => (config.fixture === undefined ? FIXTURE : config.fixture),
    openMarketsForGroup: async () => markets.filter((m) => m.status === 'open' || m.status === 'pending_lineup'),
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
    updateMarketStatus: async (id: string, status: MarketRow['status']) => {
      const m = markets.find((x) => x.id === id);
      if (m) m.status = status;
    },
    insertSettlement: async (input: Record<string, unknown>) => {
      settlements.push(input);
    },
    setMarketCardMessage: async () => undefined,
    positionsForMarket: async () => (config.positions ?? []) as never,
    playersForFixture: async () => [],
  } as unknown as EngineDb;

  const wager = {
    currencyForMint: async () => 'sol' as const,
    cardFooter: () => '⚠️ devnet SOL — /deposit to load, /withdraw to cash out.',
    presetLabels: () => ['0.01 SOL', '0.05 SOL', '0.1 SOL'] as [string, string, string],
    applySettlement: async () => undefined,
  };

  const deps = {
    db,
    wager,
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
    log: {
      info: (event: string, fields?: LogFields) => logs.push({ event, fields }),
      warn: (event: string, fields?: LogFields) => logs.push({ event, fields }),
      error: (event: string, fields?: LogFields) => logs.push({ event, fields }),
    },
    now: () => now,
  } as unknown as Deps;

  const h = {
    deps,
    poster: {
      post: (chatId: number, text: string, options: PostOptions = {}) => {
        posts.push({ chatId, text, options });
      },
      editCard: () => undefined,
      stripKeyboard: (_chatId: number, messageId: number) => {
        strippedKeyboardMessageIds.push(messageId);
      },
    },
    say: async (key: Parameters<typeof renderFallback>[0], vars = {}) => renderFallback(key, vars),
    supervisor: {
      replayFixture: () => null,
      replayRunId: () => null,
      runGroupExclusive: async (_groupId: number, task: () => Promise<unknown>) => task(),
    },
    budget: new LlmBudget(config.llmBudget ?? 1000, () => now),
  } as unknown as HandlerCtx;

  return {
    h,
    posts,
    patches,
    markets,
    settlements,
    strippedKeyboardMessageIds,
    logs,
    getClaim: () => claim,
    parseCalls: () => parseCount,
    setNow: (nextNow) => {
      now = nextNow;
    },
  };
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
    callbackQuery: { id: `callback-${userId}`, message: { message_id: 777 } },
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

function keyboardLabels(post: RecordedPost): string[] {
  const keyboard = post.options.keyboard;
  if (!keyboard) return [];
  return keyboard.inline_keyboard.flat().map((button) => button.text);
}

function rawParse() {
  return {
    claimType: 'match_winner' as const,
    fixtureId: FIXTURE_ID,
    entityName: 'Egypt',
    entityKind: 'team' as const,
    comparator: 'gte' as const,
    threshold: 1,
    period: 'FT_90' as const,
    unresolved: null,
  };
}

function logsFor(harness: Harness, event: string): readonly RecordedLog[] {
  return harness.logs.filter((entry) => entry.event === event);
}

describe('option pick prices and mints', () => {
  it('mints one SOL market and posts the two fixed starter outcomes', async () => {
    const harness = makeHarness({ claim: claimRow('clarifying', clarifyEnvelope()) });
    await dispatchCallback(harness.h, fakeCtx().ctx, { t: 'option', claimId: CLAIM_ID, key: '0' });

    expect(harness.markets).toHaveLength(1);
    expect(harness.markets[0]).toMatchObject({ currency: 'sol', quote_probability: 0.6 });
    expect(harness.getClaim().status).toBe('confirmed');
    const offer = harness.posts.at(-1)!;
    expect(keyboardLabels(offer)).toEqual([
      'It happens · 0.01 SOL',
      'It does not · 0.01 SOL',
    ]);
    expect(keyboardData(offer)).not.toContain(`nx:${CLAIM_ID}`);
  });

  it('keeps a clarifying claim pickable on a transient price failure, then mints on retry — no LLM parse', async () => {
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

    await dispatchCallback(harness.h, fakeCtx().ctx, { t: 'option', claimId: CLAIM_ID, key: '0' });
    expect(harness.getClaim().status).toBe('clarifying');
    expect(harness.markets).toHaveLength(0);
    const failure = harness.posts.at(-1)!;
    expect(failure.text).toBe(renderFallback('no_price'));
    expect(keyboardData(failure)).toContain(`op:${CLAIM_ID}:0`);
    expect(harness.patches.at(-1)?.expires_at).toBe(
      new Date(NOW + TUNABLES.UNCONFIRMED_CLAIM_TTL_MS).toISOString(),
    );

    await dispatchCallback(harness.h, fakeCtx().ctx, { t: 'option', claimId: CLAIM_ID, key: '0' });
    expect(harness.markets).toHaveLength(1);
    expect(harness.getClaim().status).toBe('confirmed');
    expect(harness.parseCalls()).toBe(0);
  });

  it('distinguishes no-odds from transient and skips the retry button when unpriceable', async () => {
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
    await dispatchCallback(unpriceable.h, fakeCtx().ctx, { t: 'option', claimId: CLAIM_ID, key: '0' });
    expect(unpriceable.posts.at(-1)?.text).toBe(renderFallback('unpriceable'));
    expect(unpriceable.posts.at(-1)?.options.keyboard).toBeUndefined();
    expect(unpriceable.getClaim().status).toBe('clarifying');
    expect(unpriceable.markets).toHaveLength(0);
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

  it('refuses to mint a degenerate (already-decided) quote', async () => {
    const harness = makeHarness({
      claim: claimRow('clarifying', clarifyEnvelope()),
      priceSpec: () => ({ ...QUOTE, probability: 1 }),
    });
    await dispatchCallback(harness.h, fakeCtx().ctx, { t: 'option', claimId: CLAIM_ID, key: '0' });
    expect(harness.markets).toHaveLength(0);
    expect(harness.posts.at(-1)?.text).toBe(renderFallback('already_decided'));
    expect(harness.getClaim().status).toBe('clarifying');
  });

  it('only the claimer can pick the terms', async () => {
    const harness = makeHarness({ claim: claimRow('clarifying', clarifyEnvelope()) });
    const other = fakeCtx(OTHER_ID);
    await dispatchCallback(harness.h, other.ctx, { t: 'option', claimId: CLAIM_ID, key: '0' });
    expect(harness.markets).toHaveLength(0);
    expect(other.toasts.some((t) => t.toLowerCase().includes('dee'))).toBe(true);
  });
});

describe('speaker confirmation', () => {
  it('does not mint a passive claim until its exact author confirms', async () => {
    const harness = makeHarness({ claim: claimRow('awaiting_confirm'), parse: rawParse });
    const other = fakeCtx(OTHER_ID);

    await dispatchCallback(harness.h, other.ctx, { t: 'confirm', claimId: CLAIM_ID });
    expect(harness.markets).toHaveLength(0);
    expect(harness.getClaim().status).toBe('awaiting_confirm');

    await dispatchCallback(harness.h, fakeCtx().ctx, { t: 'confirm', claimId: CLAIM_ID });
    expect(harness.markets).toHaveLength(1);
    expect(harness.getClaim().status).toBe('confirmed');
  });

  it('never mints when the author declines or confirms after the two-minute deadline', async () => {
    const declined = makeHarness({ claim: claimRow('awaiting_confirm'), parse: rawParse });
    await dispatchCallback(declined.h, fakeCtx().ctx, { t: 'decline', claimId: CLAIM_ID });
    await dispatchCallback(declined.h, fakeCtx().ctx, { t: 'confirm', claimId: CLAIM_ID });
    expect(declined.markets).toHaveLength(0);
    expect(declined.getClaim().status).toBe('declined');

    const expired = makeHarness({
      claim: { ...claimRow('awaiting_confirm'), expires_at: new Date(NOW + 120_000).toISOString() },
      parse: rawParse,
    });
    expired.setNow(NOW + 120_001);
    await dispatchCallback(expired.h, fakeCtx().ctx, { t: 'confirm', claimId: CLAIM_ID });
    expect(expired.markets).toHaveLength(0);
    expect(expired.getClaim().status).toBe('expired');
    expect(expired.strippedKeyboardMessageIds).toContain(777);
  });

  it('serializes replayed confirmation callbacks to one market', async () => {
    const harness = makeHarness({ claim: claimRow('awaiting_confirm'), parse: rawParse });
    const first = fakeCtx();
    const replay = fakeCtx();

    await Promise.all([
      dispatchCallback(harness.h, first.ctx, { t: 'confirm', claimId: CLAIM_ID }),
      dispatchCallback(harness.h, replay.ctx, { t: 'confirm', claimId: CLAIM_ID }),
    ]);

    expect(harness.markets).toHaveLength(1);
    expect(harness.getClaim().status).toBe('confirmed');
  });

  it('logs confirmation budget exhaustion without Telegram group identity', async () => {
    // Given an authored claim whose confirmation would exceed the group LLM budget
    const harness = makeHarness({ claim: claimRow('awaiting_confirm'), llmBudget: 0 });

    // When its author confirms the call
    await dispatchCallback(harness.h, fakeCtx().ctx, { t: 'confirm', claimId: CLAIM_ID });

    // Then the budget event retains only the safe claim identifier
    const logs = logsFor(harness, 'llm_budget_exhausted');
    expect(logs).toEqual([
      { event: 'llm_budget_exhausted', fields: { claimId: CLAIM_ID } },
    ]);
    expect(JSON.stringify(logs)).not.toContain(String(CHAT_ID));
  });
});

describe('one market per claim (finding: two markets for one claim)', () => {
  it('mints exactly one market for two concurrent option taps', async () => {
    const harness = makeHarness({ claim: claimRow('clarifying', clarifyEnvelope()) });
    const tapA = fakeCtx();
    const tapB = fakeCtx();
    await Promise.all([
      dispatchCallback(harness.h, tapA.ctx, { t: 'option', claimId: CLAIM_ID, key: '0' }),
      dispatchCallback(harness.h, tapB.ctx, { t: 'option', claimId: CLAIM_ID, key: '0' }),
    ]);
    expect(harness.markets).toHaveLength(1);
    expect(harness.getClaim().status).toBe('confirmed');
    expect([...tapA.toasts, ...tapB.toasts]).toContain(renderFallback('hold_on'));
  });

  it('answers stale (no second market) for an option tap after the mint', async () => {
    const harness = makeHarness({ claim: claimRow('clarifying', clarifyEnvelope()) });
    await dispatchCallback(harness.h, fakeCtx().ctx, { t: 'option', claimId: CLAIM_ID, key: '0' });
    const late = fakeCtx();
    await dispatchCallback(harness.h, late.ctx, { t: 'option', claimId: CLAIM_ID, key: '1' });
    expect(harness.markets).toHaveLength(1);
    expect(late.toasts).toContain(renderFallback('stale'));
  });

  it('treats a fixture-lookup miss as transient (retry, no mint, claim survives)', async () => {
    const harness = makeHarness({
      claim: claimRow('clarifying', clarifyEnvelope()),
      fixture: null,
    });
    await dispatchCallback(harness.h, fakeCtx().ctx, { t: 'option', claimId: CLAIM_ID, key: '0' });
    expect(harness.markets).toHaveLength(0);
    expect(harness.getClaim().status).toBe('clarifying');
    expect(harness.patches.some((patch) => patch.status === 'expired')).toBe(false);
    expect(harness.posts.at(-1)?.text).toBe(renderFallback('hiccup'));
  });
});

describe('prove = re-parse retry (findings: double parse, stranded clarifying, TTL)', () => {
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
    expect(harness.getClaim().status).toBe('nudged');
    const retry = harness.posts.at(-1)!;
    expect(retry.text).toBe(renderFallback('prove_retry'));
    expect(keyboardData(retry)).toContain(`pv:${CLAIM_ID}`);
  });

  it('meters the prove parse and logs exhaustion without Telegram group identity', async () => {
    const harness = makeHarness({ claim: claimRow('nudged'), llmBudget: 0 });
    const tap = fakeCtx();
    await dispatchCallback(harness.h, tap.ctx, { t: 'prove', claimId: CLAIM_ID });
    expect(harness.parseCalls()).toBe(0);
    expect(harness.getClaim().status).toBe('nudged');
    expect(tap.toasts).toContain(renderFallback('budget_spent'));
    const logs = logsFor(harness, 'llm_budget_exhausted');
    expect(logs).toEqual([
      { event: 'llm_budget_exhausted', fields: { claimId: CLAIM_ID } },
    ]);
    expect(JSON.stringify(logs)).not.toContain(String(CHAT_ID));
  });

  it('mints straight from a successful prove re-parse and extends the TTL', async () => {
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
    expect(harness.markets).toHaveLength(1);
    expect(harness.getClaim().status).toBe('confirmed');
  });
});

describe('decline — pre-mint kill, post-mint void', () => {
  it('kills a pre-mint claim for the claimer', async () => {
    const harness = makeHarness({ claim: claimRow('clarifying', clarifyEnvelope()) });
    const tap = fakeCtx();
    await dispatchCallback(harness.h, tap.ctx, { t: 'decline', claimId: CLAIM_ID });
    expect(harness.getClaim().status).toBe('declined');
    expect(tap.toasts).toContain(renderFallback('confirm_declined'));
  });

  it('voids a minted market that no one bet on', async () => {
    const harness = makeHarness({ claim: claimRow('confirmed') });
    // Seed a minted, unbet market for this claim.
    harness.markets.push({
      id: 'market-1',
      claim_id: CLAIM_ID,
      group_id: CHAT_ID,
      status: 'open',
      currency: 'sol',
      spec: spec(),
    } as unknown as MarketRow);
    const tap = fakeCtx();
    await dispatchCallback(harness.h, tap.ctx, { t: 'decline', claimId: CLAIM_ID });
    expect(harness.markets[0]?.status).toBe('voided');
    expect(harness.settlements.at(-1)).toMatchObject({ outcome: 'void' });
    expect(tap.toasts).toContain(renderFallback('confirm_declined'));
  });

  it('refuses to void once real SOL is on the offer', async () => {
    const harness = makeHarness({ claim: claimRow('confirmed'), positions: [{ state: 'active' }] });
    harness.markets.push({
      id: 'market-1',
      claim_id: CLAIM_ID,
      group_id: CHAT_ID,
      status: 'open',
      currency: 'sol',
      spec: spec(),
    } as unknown as MarketRow);
    const tap = fakeCtx();
    await dispatchCallback(harness.h, tap.ctx, { t: 'decline', claimId: CLAIM_ID });
    expect(harness.markets[0]?.status).toBe('open');
    expect(tap.toasts).toContain(renderFallback('offer_taken'));
  });

  it('lets only the claimer decline', async () => {
    const harness = makeHarness({ claim: claimRow('clarifying', clarifyEnvelope()) });
    const other = fakeCtx(OTHER_ID);
    await dispatchCallback(harness.h, other.ctx, { t: 'decline', claimId: CLAIM_ID });
    expect(harness.getClaim().status).toBe('clarifying');
    expect(other.toasts.some((t) => t.toLowerCase().includes('dee'))).toBe(true);
  });
});
