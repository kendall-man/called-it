import { checkDebounce, reduceMarket, type MatchEvent } from '@calledit/market-engine';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import type { Deps, MarketRow } from '../ports.js';
import type { EscrowAttestationRequestService } from './attestation-request-service.js';
import { normalizedEscrowEvidenceHash } from './event-attestations.js';
import {
  createEscrowEventWorkflowScheduler,
  createEscrowSettlementEntitlementScheduler,
  type EscrowEventWorkflowPort,
} from './event-workflow-scheduler.js';

const MARKET_PDA = Keypair.generate().publicKey.toBase58();
const OWNER = Keypair.generate().publicKey.toBase58();
const LOT_PDA = Keypair.generate().publicKey.toBase58();
const MARKET_ID = '123e4567-e89b-12d3-a456-426614174000';
const GROUP_ID = -100_123;

function event(overrides: Partial<MatchEvent> = {}): MatchEvent {
  return {
    kind: 'goal', fixtureId: 77, seq: 12, tsMs: 100_000, receivedAtMs: 101_000,
    confirmed: true, phase: 'H1', minute: 20,
    score: {
      p1: { goals: 1, yellowCards: 0, redCards: 0, corners: 0 },
      p2: { goals: 0, yellowCards: 0, redCards: 0, corners: 0 },
      p1Goals90: null, p2Goals90: null,
    },
    detail: { participant: 1 },
    ...overrides,
  };
}

function market(replay = false, custodyMode: 'legacy' | 'escrow' = 'escrow'): MarketRow {
  return {
    id: MARKET_ID, claim_id: '223e4567-e89b-12d3-a456-426614174000', group_id: GROUP_ID,
    fixture_id: 77, status: 'open', is_replay: replay, currency: 'sol', custody_mode: custodyMode,
    spec: {
      claimType: 'match_winner', fixtureId: 77,
      entityRef: { kind: 'team', participant: 1, name: 'Home' },
      comparator: 'eq', threshold: 1, period: 'FT', trustTier: 'oracle_resolved',
    },
    price_provenance: 'market', quote_probability: 0.5, quote_multiplier: 2,
    odds_message_id: 'odds-1', odds_ts: 90_000, card_tg_message_id: null,
    created_at: '2026-07-15T00:00:00.000Z',
  };
}

type PersistInput = Parameters<EscrowAttestationRequestService['enqueue']>[0];

function setup(
  replay = false,
  persisted: PersistInput[] = [],
  custodyMode: 'legacy' | 'escrow' = 'escrow',
  failOnceAt?: number,
  loadFailures = 0,
  finalizedAfterEnqueueFailure?: { readonly chainState: 'open' | 'frozen'; readonly eventEpoch: bigint },
  emptyLots = false,
) {
  const currentMarket = market(replay, custodyMode);
  const workflow: EscrowEventWorkflowPort = {
    async loadMarket() {
      loadCalls += 1;
      if (loadCalls <= loadFailures) throw new Error('transient RPC failure');
      const finalized = enqueueCalls > 0 ? finalizedAfterEnqueueFailure : undefined;
      return {
        chainState: finalized?.chainState ?? 'open', replay,
        oraclePolicy: {
          oracleSetEpoch: 7n,
          signers: ['oracle-a', 'oracle-b', 'oracle-c'],
          threshold: 2,
        },
        binding: {
          marketId: MARKET_ID, marketPda: MARKET_PDA, marketDocumentHashHex: 'ab'.repeat(32),
          fixtureId: 77n, oracleSetEpoch: 7n, eventEpoch: finalized?.eventEpoch ?? 3n,
        },
      };
    },
    async positionLots() {
      if (emptyLots) return [];
      return [{
        ownerPubkey: OWNER, lotNonce: 2n, positionLotPda: LOT_PDA,
        placedTimestamp: 101n, observedEventEpoch: 3n, activationTimestamp: 110n,
        state: 'pending',
      }];
    },
  };
  let loadCalls = 0;
  let marketLookupCalls = 0;
  const infoLogs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const deps = {
    db: {
      async openMarketsForFixture() { marketLookupCalls += 1; return [currentMarket]; },
      async positionsForMarket() { return []; },
    },
    engine: { reduceMarket, checkDebounce },
    log: {
      info(logEvent: string, fields: Record<string, unknown>) {
        infoLogs.push({ event: logEvent, fields });
      },
      error() {},
    },
  };
  const seen = new Set<string>();
  let enqueueCalls = 0;
  const requests = {
    async enqueue(input: PersistInput) {
      enqueueCalls += 1;
      if (enqueueCalls === failOnceAt) throw new Error('service unavailable');
      const key = JSON.stringify(input, (_name, value) => typeof value === 'bigint' ? String(value) : value);
      const created = !seen.has(key);
      seen.add(key);
      if (created) persisted.push(input);
      return { kind: 'persisted' as const, created, requestKey: 'ab'.repeat(32) };
    },
  };
  const scheduler = createEscrowEventWorkflowScheduler({
    deps,
    deployment: {
      genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
      programId: 'HrKUo8Bue31kU9sobzQGK5qDxVxBu5nBLXP3aGeKCDFL',
    },
    requests, workflow,
  });
  return {
    scheduler, persisted, currentMarket,
    loadCalls: () => loadCalls,
    marketLookupCalls: () => marketLookupCalls,
    infoLogs,
  };
}

describe('escrow TxLINE durable event workflow scheduler', () => {
  it('persists freeze and exact anti-snipe invalidation before any signing', async () => {
    const fixture = setup();
    await fixture.scheduler.onEvent(event());

    expect(fixture.persisted.map((value) => value.request.operation)).toEqual([
      'freeze_market', 'invalidate_position_lot',
    ]);
    expect(fixture.persisted[1]?.request).toMatchObject({
      owner: OWNER, lotNonce: 2n, positionLotPda: LOT_PDA,
      attestation: { observedEventEpoch: 3n, invalidatedEventEpoch: 4n },
    });
  });

  it('binds replay oracle evidence to provider time, not the accelerated test clock', async () => {
    const fixture = setup(true);
    const shifted = {
      ...event({ tsMs: 500_000, receivedAtMs: 501_000 }),
      providerTsMs: 100_000,
    };

    await fixture.scheduler.onReplayEvent(GROUP_ID, shifted, 0);

    expect(fixture.persisted.find((value) => value.request.operation === 'freeze_market')?.request)
      .toMatchObject({ attestation: { observedAt: 100n } });
  });

  it('admits only DB-stamped escrow custody, not legacy rows in the same enabled group', async () => {
    const fixture = setup(false, [], 'legacy');

    await fixture.scheduler.onEvent(event());

    expect(fixture.persisted.some((value) => value.request.operation === 'settle_market')).toBe(false);
  });

  it('continues settlement for a linked escrow market after its group leaves the intake allowlist', async () => {
    const fixture = setup();
    await fixture.scheduler.onEvent(event({
      kind: 'phase_change', seq: 20, phase: 'F', minute: 90,
      receivedAtMs: 200_000, tsMs: 199_000,
      score: {
        p1: { goals: 2, yellowCards: 0, redCards: 0, corners: 0 },
        p2: { goals: 1, yellowCards: 0, redCards: 0, corners: 0 },
        p1Goals90: 2, p2Goals90: 1,
      },
    }));

    expect(fixture.persisted).toContainEqual(expect.objectContaining({
      marketId: MARKET_ID,
      request: expect.objectContaining({ operation: 'settle_market', marketPda: MARKET_PDA }),
    }));
  });

  it('retries the same event after a partial persistence failure and stores missing intents', async () => {
    const fixture = setup(false, [], 'escrow', 2);
    const priceMove = event();

    await fixture.scheduler.onEvent(priceMove);
    expect(fixture.persisted.map((value) => value.request.operation)).toEqual(['freeze_market']);

    await fixture.scheduler.onEvent(priceMove);
    expect(fixture.persisted.map((value) => value.request.operation)).toEqual([
      'freeze_market', 'invalidate_position_lot',
    ]);
  });

  it('persists a terminal candidate with its debounce deadline before restart', async () => {
    const persisted: PersistInput[] = [];
    const terminal = event({
      kind: 'phase_change', seq: 20, phase: 'F', minute: 90,
      receivedAtMs: 200_000, tsMs: 199_000,
      score: {
        p1: { goals: 2, yellowCards: 0, redCards: 0, corners: 0 },
        p2: { goals: 1, yellowCards: 0, redCards: 0, corners: 0 },
        p1Goals90: 2, p2Goals90: 1,
      },
    });
    await setup(false, persisted).scheduler.onEvent(terminal);

    const settlement = persisted.find((value) => value.request.operation === 'settle_market');
    expect(settlement).toMatchObject({
      dueAtIso: new Date(290_000).toISOString(),
      debounceUntilIso: new Date(290_000).toISOString(),
      request: { operation: 'settle_market', attestation: { decidingSequence: 20n } },
    });
    await setup(false, persisted).scheduler.tick(300_000);
    expect(persisted.filter((value) => value.request.operation === 'settle_market')).toHaveLength(1);
  });

  it('routes replay terminal events through the same durable Points-disabled path', async () => {
    const fixture = setup(true, [], 'escrow', undefined, 0, undefined, true);
    await fixture.scheduler.onReplayEvent(GROUP_ID, event({
      kind: 'phase_change', seq: 20, phase: 'F', minute: 90,
      receivedAtMs: 200_000, tsMs: 199_000,
      score: {
        p1: { goals: 2, yellowCards: 0, redCards: 0, corners: 0 },
        p2: { goals: 1, yellowCards: 0, redCards: 0, corners: 0 },
        p1Goals90: 2, p2Goals90: 1,
      },
    }), 0);
    expect(fixture.persisted.some((value) => value.request.operation === 'settle_market')).toBe(false);
    await fixture.scheduler.finalizeReplay(GROUP_ID, 77, 0);

    expect(fixture.persisted.find((value) => value.request.operation === 'settle_market')).toMatchObject({
      replay: true, request: { operation: 'settle_market' },
    });
  });

  it('settles a replay after an epoch-millisecond odds suspension sequence', async () => {
    const fixture = setup(true, [], 'escrow', undefined, 0, undefined, true);
    await fixture.scheduler.onReplayEvent(GROUP_ID, event(), 0);
    await fixture.scheduler.onReplayEvent(GROUP_ID, event({
      kind: 'odds_suspension', seq: 1_784_148_352_217,
      tsMs: 1_784_148_352_217, receivedAtMs: 150_000,
      phase: 'H2', minute: null,
    }), 0);
    await fixture.scheduler.onReplayEvent(GROUP_ID, event({
      kind: 'phase_change', seq: 20, phase: 'F', minute: 90,
      receivedAtMs: 200_000, tsMs: 199_000,
      score: {
        p1: { goals: 1, yellowCards: 0, redCards: 0, corners: 0 },
        p2: { goals: 2, yellowCards: 0, redCards: 0, corners: 0 },
        p1Goals90: 1, p2Goals90: 2,
      },
    }), 0);
    expect(fixture.persisted).toEqual([]);
    await fixture.scheduler.finalizeReplay(GROUP_ID, 77, 0);

    expect(fixture.persisted.find((value) => value.request.operation === 'settle_market'))
      .toMatchObject({ replay: true, request: { operation: 'settle_market' } });
  });

  it('excludes a prior-run replay escrow market from the active replay run', async () => {
    const fixture = setup(true);

    await fixture.scheduler.onReplayEvent(
      GROUP_ID,
      event(),
      Date.parse('2026-07-16T00:00:00.000Z'),
    );

    expect(fixture.loadCalls()).toBe(0);
    expect(fixture.persisted).toEqual([]);
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY])(
    'fails closed before market lookup for invalid replay boundary %s',
    async (replayStartedAtMs) => {
      const fixture = setup(true);

      await fixture.scheduler.onReplayEvent(GROUP_ID, event(), replayStartedAtMs as number);

      expect(fixture.marketLookupCalls()).toBe(0);
      expect(fixture.loadCalls()).toBe(0);
      expect(fixture.persisted).toEqual([]);
    },
  );

  it.each([
    ['another group', (row: MarketRow) => { row.group_id = GROUP_ID - 1; }],
    ['another fixture', (row: MarketRow) => { row.fixture_id = 78; }],
    ['a live market', (row: MarketRow) => { row.is_replay = false; }],
  ])('excludes %s from replay escrow settlement recovery', async (_label, exclude) => {
    const fixture = setup(true);
    exclude(fixture.currentMarket);

    await fixture.scheduler.onReplayEvent(GROUP_ID, event(), 0);

    expect(fixture.persisted).toEqual([]);
  });

  it('does not read finalized Solana state for replay events with no on-chain effect', async () => {
    const fixture = setup(true);

    await fixture.scheduler.onReplayEvent(GROUP_ID, event({ kind: 'stat_update' }), 0);

    expect(fixture.loadCalls()).toBe(0);
    expect(fixture.persisted).toEqual([]);
  });

  it('fails a replay immediately on a transient RPC boundary', async () => {
    const fixture = setup(true, [], 'escrow', undefined, 2);
    await expect(fixture.scheduler.onReplayEvent(GROUP_ID, event(), 0))
      .rejects.toThrow('transient RPC failure');

    expect(fixture.loadCalls()).toBe(1);
    expect(fixture.persisted).toEqual([]);
  });

  it('fails a replay immediately when attestation persistence is unavailable', async () => {
    const fixture = setup(true, [], 'escrow', 1);

    await expect(fixture.scheduler.onReplayEvent(GROUP_ID, event(), 0))
      .rejects.toThrow('attestation_storage_unavailable');

    expect(fixture.persisted).toEqual([]);
  });

  it('accepts a replay freeze that finalized between context load and durable enqueue', async () => {
    const fixture = setup(
      true, [], 'escrow', 1, 0,
      { chainState: 'frozen', eventEpoch: 4n },
    );

    await fixture.scheduler.onReplayEvent(GROUP_ID, event(), 0);

    expect(fixture.loadCalls()).toBe(2);
    expect(fixture.persisted.map((value) => value.request.operation)).toEqual([
      'invalidate_position_lot',
    ]);
    expect(fixture.infoLogs).toContainEqual({
      event: 'escrow_control_transition_already_finalized',
      fields: {
        marketId: MARKET_ID,
        seq: 12,
        operation: 'freeze_market',
        eventEpoch: '4',
      },
    });
  });

  it('settles an empty replay market without redundant control transactions', async () => {
    const fixture = setup(true, [], 'escrow', undefined, 0, undefined, true);

    await fixture.scheduler.onReplayEvent(GROUP_ID, event(), 0);
    const terminal = event({
      kind: 'phase_change', seq: 20, phase: 'F', minute: 90,
      receivedAtMs: 200_000, tsMs: 199_000,
      score: {
        p1: { goals: 2, yellowCards: 0, redCards: 0, corners: 0 },
        p2: { goals: 1, yellowCards: 0, redCards: 0, corners: 0 },
        p1Goals90: 2, p2Goals90: 1,
      },
    });
    await fixture.scheduler.onReplayEvent(GROUP_ID, terminal, 0);
    expect(fixture.persisted).toEqual([]);

    // A later canonical record confirms the debounce candidate. Additional
    // post-whistle records must not enqueue another terminal request while the
    // finalized projection is still catching up.
    await fixture.scheduler.onReplayEvent(GROUP_ID, event({
      ...terminal, kind: 'stat_update', seq: 21, receivedAtMs: 201_000,
    }), 0);
    const latest = event({
      ...terminal, kind: 'stat_update', seq: 22, tsMs: 202_000, receivedAtMs: 202_000,
    });
    await fixture.scheduler.onReplayEvent(GROUP_ID, latest, 0);
    expect(fixture.persisted).toEqual([]);
    await fixture.scheduler.finalizeReplay(GROUP_ID, 77, 0);

    expect(fixture.persisted.map((value) => value.request.operation)).toEqual(['settle_market']);
    expect(fixture.persisted[0]?.request).toMatchObject({
      operation: 'settle_market',
      attestation: {
        decidingSequence: 20n,
        normalizedEvidenceRoot: normalizedEscrowEvidenceHash(latest),
      },
    });
    expect(fixture.infoLogs).toContainEqual({
      event: 'escrow_replay_control_skipped_empty_market',
      fields: { marketId: MARKET_ID, seq: 12 },
    });
  });

  it('recovers a pending-only replay with one truthful settlement and no control transactions', async () => {
    const fixture = setup(true);
    await fixture.scheduler.onReplayRecoveryEvent(GROUP_ID, event());
    await fixture.scheduler.onReplayRecoveryEvent(GROUP_ID, event({
      kind: 'phase_change', seq: 20, phase: 'F', minute: 90,
      receivedAtMs: 200_000, tsMs: 199_000,
      score: {
        p1: { goals: 2, yellowCards: 0, redCards: 0, corners: 0 },
        p2: { goals: 1, yellowCards: 0, redCards: 0, corners: 0 },
        p1Goals90: 2, p2Goals90: 1,
      },
    }));
    expect(fixture.persisted).toEqual([]);

    await fixture.scheduler.finalizeReplayRecovery(GROUP_ID, 77);

    expect(fixture.persisted.map((value) => value.request.operation)).toEqual(['settle_market']);
  });

  it('matures a lone empty-replay terminal candidate exactly once at replay EOF', async () => {
    const fixture = setup(true, [], 'escrow', undefined, 0, undefined, true);
    const terminal = event({
      kind: 'phase_change', seq: 20, phase: 'F', minute: 90,
      receivedAtMs: 200_000, tsMs: 199_000,
      score: {
        p1: { goals: 2, yellowCards: 0, redCards: 0, corners: 0 },
        p2: { goals: 1, yellowCards: 0, redCards: 0, corners: 0 },
        p1Goals90: 2, p2Goals90: 1,
      },
    });

    await fixture.scheduler.onReplayEvent(GROUP_ID, terminal, 0);
    expect(fixture.persisted).toEqual([]);
    await fixture.scheduler.finalizeReplay(GROUP_ID, 77, 0);
    await fixture.scheduler.finalizeReplay(GROUP_ID, 77, 0);

    expect(fixture.persisted.map((value) => value.request.operation)).toEqual(['settle_market']);
    expect(fixture.persisted[0]?.request).toMatchObject({
      operation: 'settle_market',
      attestation: {
        decidingSequence: 20n,
        normalizedEvidenceRoot: normalizedEscrowEvidenceHash(terminal),
      },
    });
  });

  it('maps cancellation to durable void and ignores duplicate or reordered events', async () => {
    const fixture = setup();
    const cancellation = event({ kind: 'phase_change', seq: 30, phase: 'CAN', confirmed: true });
    await fixture.scheduler.onEvent(cancellation);
    await fixture.scheduler.onEvent(cancellation);
    await fixture.scheduler.onEvent(event({ seq: 29 }));

    expect(fixture.persisted.filter((value) => value.request.operation === 'void_market')).toHaveLength(1);
    expect(fixture.persisted.find((value) => value.request.operation === 'void_market')?.request).toMatchObject({
      operation: 'void_market', attestation: { reason: 'cancelled', decidingSequence: 30n },
    });
  });
});

describe('escrow settlement entitlement scheduler', () => {
  it('durably enqueues every unprocessed owner and safely retries a partial fan-out', async () => {
    const ownerA = Keypair.generate().publicKey.toBase58();
    const ownerB = Keypair.generate().publicKey.toBase58();
    const processedOwner = Keypair.generate().publicKey.toBase58();
    const enqueued: string[] = [];
    let failOwnerB = true;
    const scheduler = createEscrowSettlementEntitlementScheduler({
      positions: {
        async positions() {
          return [
            { ownerPubkey: ownerA, settlementProcessed: false },
            { ownerPubkey: ownerB, settlementProcessed: false },
            { ownerPubkey: processedOwner, settlementProcessed: true },
          ];
        },
      },
      recovery: {
        async enqueue(request) {
          if (request.operation !== 'calculate_position_entitlement') throw new Error('unexpected operation');
          if (request.owner === ownerB && failOwnerB) {
            failOwnerB = false;
            throw new Error('durable storage unavailable');
          }
          enqueued.push(request.owner);
          return { kind: 'enqueued', created: true, jobId: `job-${enqueued.length}` };
        },
      },
    });
    const input = { marketId: MARKET_ID, marketPda: MARKET_PDA, positionCount: 3n };

    await expect(scheduler.afterSettlementFinalized(input)).rejects.toThrow('durable storage unavailable');
    await expect(scheduler.afterSettlementFinalized(input)).resolves.toBeUndefined();

    expect(enqueued).toEqual([ownerA, ownerA, ownerB]);
    expect(enqueued).not.toContain(processedOwner);
  });

  it('does not enqueue from an incomplete or duplicate owner projection', async () => {
    const enqueueCalls: unknown[] = [];
    const owner = Keypair.generate().publicKey.toBase58();
    const scheduler = createEscrowSettlementEntitlementScheduler({
      positions: {
        async positions() {
          return [
            { ownerPubkey: owner, settlementProcessed: false },
            { ownerPubkey: owner, settlementProcessed: false },
          ];
        },
      },
      recovery: {
        async enqueue(request) {
          enqueueCalls.push(request);
          return { kind: 'enqueued', created: true, jobId: 'job-a' };
        },
      },
    });

    await expect(scheduler.afterSettlementFinalized({
      marketId: MARKET_ID, marketPda: MARKET_PDA, positionCount: 2n,
    })).rejects.toThrow('escrow settlement position projection mismatch');
    expect(enqueueCalls).toEqual([]);
  });
});
