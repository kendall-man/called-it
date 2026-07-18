import { describe, expect, it } from 'vitest';
import type { MarketState, MatchEvent, SettlementOutcome } from '@calledit/market-engine';
import type { Deps, MarketRow } from '../ports.js';
import type { Poster } from '../bot/poster.js';
import { reactToSettledClaim, Settler } from './settler.js';

const GROUP_ID = -100_800;
const FIXTURE_ID = 18_209_282;
const CLAIM_MESSAGE_ID = 4_101;

function market(overrides: Partial<MarketRow> = {}): MarketRow {
  return {
    id: '00000000-0000-4000-8000-000000000801',
    claim_id: '00000000-0000-4000-8000-000000000602',
    group_id: GROUP_ID,
    fixture_id: FIXTURE_ID,
    spec: {
      claimType: 'match_winner',
      fixtureId: FIXTURE_ID,
      entityRef: { kind: 'team', participant: 1, name: 'France' },
      comparator: 'gte',
      threshold: 1,
      period: 'FT_90',
      trustTier: 'oracle_resolved',
    },
    status: 'open',
    is_replay: true,
    price_provenance: 'market',
    quote_probability: 0.6,
    quote_multiplier: 1.6,
    odds_message_id: 'odds-1',
    odds_ts: 1,
    card_tg_message_id: null,
    created_at: '2026-07-13T10:00:00.000Z',
    currency: 'sol',
    custody_mode: 'legacy',
    ...overrides,
  };
}

const EVENT: MatchEvent = {
  kind: 'phase_change',
  fixtureId: FIXTURE_ID,
  seq: 1,
  tsMs: Date.parse('2026-07-13T10:01:00.000Z'),
  receivedAtMs: Date.parse('2026-07-13T10:01:01.000Z'),
  confirmed: true,
  phase: 'F',
  minute: 90,
  score: {
    p1: { goals: 1, yellowCards: 0, redCards: 0, corners: 0 },
    p2: { goals: 0, yellowCards: 0, redCards: 0, corners: 0 },
    p1Goals90: 1,
    p2Goals90: 0,
  },
};

type ReactCall = { chatId: number; messageId: number; emoji: string };

function reactionHarness(input: {
  outcome: SettlementOutcome;
  getClaim?: () => Promise<unknown>;
}): {
  settler: Settler;
  reactions: ReactCall[];
  settlements: SettlementOutcome[];
  warnings: string[];
} {
  const reactions: ReactCall[] = [];
  const settlements: SettlementOutcome[] = [];
  const warnings: string[] = [];
  const target = market();
  const deps = {
    db: {
      openMarketsForFixture: async () => [target],
      positionsForMarket: async () => [],
      updateMarketStatus: async () => undefined,
      insertSettlement: async (row: { outcome: SettlementOutcome }) => {
        settlements.push(row.outcome);
      },
      getClaim: input.getClaim ?? (async () => ({
        id: target.claim_id,
        group_id: GROUP_ID,
        claimer_user_id: 800,
        tg_message_id: CLAIM_MESSAGE_ID,
        quoted_text: 'France will win',
        status: 'confirmed',
        classifier_confidence: 1,
        parse: null,
        expires_at: null,
        created_at: target.created_at,
      })),
    },
    engine: {
      reduceMarket(state: MarketState) {
        return {
          state: { ...state, status: input.outcome === 'void' ? 'voided' as const : 'settled' as const },
          effects: input.outcome === 'void'
            ? [{ kind: 'void' as const, reason: 'test void' }]
            : [{
                kind: 'settle' as const,
                outcome: input.outcome,
                decidingSeq: EVENT.seq,
                evidenceSeqs: [EVENT.seq],
              }],
        };
      },
    },
    log: {
      info() {},
      warn(event: string) { warnings.push(event); },
      error() {},
      child() { return this; },
    },
  } as unknown as Deps;
  const poster = {
    post() {},
    editCard() {},
    stripKeyboard() {},
    react(chatId: number, messageId: number, emoji: string) {
      reactions.push({ chatId, messageId, emoji });
    },
    chatAction() {},
  } as unknown as Poster;
  const settler = new Settler(
    deps,
    poster,
    async () => '',
    { apply: async () => ({ eligible: false }) } as never,
    null,
  );
  settler.postReceipt = async () => undefined;
  return { settler, reactions, settlements, warnings };
}

describe('Settler settled-claim reaction', () => {
  it('reacts on the original claim message when the call lands', async () => {
    const harness = reactionHarness({ outcome: 'claim_won' });

    await harness.settler.onReplayEvent(GROUP_ID, EVENT);

    // Telegram's reaction set has no 🎯; the trophy is the landed-call ack.
    expect(harness.reactions).toEqual([
      { chatId: GROUP_ID, messageId: CLAIM_MESSAGE_ID, emoji: '🏆' },
    ]);
    expect(harness.settlements).toEqual(['claim_won']);
  });

  it('stays silent when the call loses or the market voids', async () => {
    for (const outcome of ['claim_lost', 'void'] as const) {
      const harness = reactionHarness({ outcome });

      await harness.settler.onReplayEvent(GROUP_ID, EVENT);

      expect(harness.reactions).toEqual([]);
    }
  });

  it('never blocks settlement when the claim lookup fails', async () => {
    const harness = reactionHarness({
      outcome: 'claim_won',
      getClaim: async () => { throw new Error('claim row unavailable'); },
    });

    await harness.settler.onReplayEvent(GROUP_ID, EVENT);

    expect(harness.settlements).toEqual(['claim_won']);
    expect(harness.reactions).toEqual([]);
    expect(harness.warnings).toContain('settled_claim_reaction_skipped');
  });
});

describe('escrow projection-sink settled-claim reaction', () => {
  // The finalized-indexer projection sink (main.ts) calls the exported helper
  // directly, so escrow-custody settlements celebrate like legacy ones.
  function helperHarness(getClaim?: () => Promise<unknown>) {
    const reactions: ReactCall[] = [];
    const warnings: string[] = [];
    const deps = {
      db: {
        getClaim: getClaim ?? (async () => ({ tg_message_id: CLAIM_MESSAGE_ID })),
      },
      log: { warn(event: string) { warnings.push(event); } },
    } as unknown as Pick<Deps, 'db' | 'log'>;
    const poster = {
      react(chatId: number, messageId: number, emoji: string) {
        reactions.push({ chatId, messageId, emoji });
      },
    };
    return { deps, poster, reactions, warnings };
  }

  it('reacts on claim_won and stays silent otherwise', async () => {
    const won = helperHarness();
    await reactToSettledClaim(won.deps, won.poster, market(), 'claim_won');
    expect(won.reactions).toEqual([
      { chatId: GROUP_ID, messageId: CLAIM_MESSAGE_ID, emoji: '🏆' },
    ]);

    for (const outcome of ['claim_lost', 'void'] as const) {
      const silent = helperHarness();
      await reactToSettledClaim(silent.deps, silent.poster, market(), outcome);
      expect(silent.reactions).toEqual([]);
    }
  });

  it('swallows lookup failures with a warning', async () => {
    const failing = helperHarness(async () => { throw new Error('claim row unavailable'); });

    await reactToSettledClaim(failing.deps, failing.poster, market(), 'claim_won');

    expect(failing.reactions).toEqual([]);
    expect(failing.warnings).toContain('settled_claim_reaction_skipped');
  });
});
