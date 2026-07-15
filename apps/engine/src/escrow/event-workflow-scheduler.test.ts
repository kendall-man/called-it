import { checkDebounce, reduceMarket, type MatchEvent } from '@calledit/market-engine';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import type { Deps, MarketRow } from '../ports.js';
import { createEscrowEventWorkflowScheduler, type EscrowEventWorkflowPort } from './event-workflow-scheduler.js';
import type { EscrowControlRequest } from './control-workflows.js';
import type { EscrowRecoveryRequest } from './recovery-workflows.js';

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

function market(replay = false): MarketRow {
  return {
    id: MARKET_ID, claim_id: '223e4567-e89b-12d3-a456-426614174000', group_id: GROUP_ID,
    fixture_id: 77, status: 'open', is_replay: replay, currency: 'sol',
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

function setup(replay = false) {
  const control: EscrowControlRequest[] = [];
  const recovery: EscrowRecoveryRequest[] = [];
  const signingKinds: string[] = [];
  const currentMarket = market(replay);
  const workflow: EscrowEventWorkflowPort = {
    async loadMarket() {
      return {
        chainState: 'open', replay,
        oraclePolicy: {
          oracleSetEpoch: 7n,
          signers: ['oracle-a', 'oracle-b', 'oracle-c'],
          threshold: 2,
        },
        binding: {
          marketId: MARKET_ID, marketPda: MARKET_PDA, marketDocumentHashHex: 'ab'.repeat(32),
          fixtureId: 77n, oracleSetEpoch: 7n, eventEpoch: 3n,
        },
      };
    },
    async positionLots() {
      return [{
        ownerPubkey: OWNER, lotNonce: 2n, positionLotPda: LOT_PDA,
        placedTimestamp: 101n, observedEventEpoch: 3n, activationTimestamp: 110n,
        state: 'pending',
      }];
    },
    async enqueueControl(value) { control.push(value); },
    async enqueueRecovery(value) { recovery.push(value); },
  };
  const deps = {
    db: {
      async openMarketsForFixture() { return [currentMarket]; },
      async positionsForMarket() { return []; },
      async getMarket() { return currentMarket; },
    },
    engine: { reduceMarket, checkDebounce },
    log: { info() {}, error() {} },
  } as unknown as Pick<Deps, 'db' | 'engine' | 'log'>;
  const signers = [Keypair.generate(), Keypair.generate()];
  const scheduler = createEscrowEventWorkflowScheduler({
    deps, allowedGroupIds: [GROUP_ID],
    deployment: {
      genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
      programId: 'HrKUo8Bue31kU9sobzQGK5qDxVxBu5nBLXP3aGeKCDFL',
    },
    oracle: {
      async availableSigners() { return signers.map((value) => value.publicKey.toBase58()); },
      async sign(value) {
        signingKinds.push(value.kind);
        return signers.map((signer) => ({ publicKey: signer.publicKey.toBytes(), signature: new Uint8Array(64) }));
      },
    },
    workflow, clock: () => 1_700_000_000n,
  });
  return { scheduler, control, recovery, signingKinds };
}

describe('escrow TxLINE event workflow scheduler', () => {
  it('signs and queues freeze plus exact anti-snipe invalidation for a live price event', async () => {
    const fixture = setup();
    await fixture.scheduler.onEvent(event());

    expect(fixture.control.map((value) => value.operation)).toEqual([
      'freeze_market', 'invalidate_position_lot',
    ]);
    expect(fixture.control[1]).toMatchObject({
      owner: OWNER, lotNonce: 2n, positionLotPda: LOT_PDA,
      attestation: { observedEventEpoch: 3n, invalidatedEventEpoch: 4n },
    });
    expect(fixture.signingKinds).toEqual(['feed_event', 'position_invalidation']);
  });

  it('turns a terminal reducer candidate into a signed durable settlement on tick', async () => {
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
    await fixture.scheduler.tick(200_000 + 90_001);

    expect(fixture.recovery).toHaveLength(1);
    expect(fixture.recovery[0]).toMatchObject({
      operation: 'settle_market', marketPda: MARKET_PDA,
      attestation: { outcome: 'claim_won', decidingSequence: 20n },
    });
    expect(fixture.signingKinds).toContain('settlement');
  });

  it('routes replay terminal events through the same signed path', async () => {
    const fixture = setup(true);
    const terminal = event({
      kind: 'phase_change', seq: 20, phase: 'F', minute: 90,
      receivedAtMs: 200_000, tsMs: 199_000,
    });
    await fixture.scheduler.onReplayEvent(GROUP_ID, terminal, 0);
    await fixture.scheduler.tick(300_001);

    expect(fixture.recovery[0]?.operation).toBe('settle_market');
  });

  it('maps cancellation to a threshold-signed void and never a legacy write', async () => {
    const fixture = setup();
    await fixture.scheduler.onEvent(event({
      kind: 'phase_change', seq: 30, phase: 'CAN', confirmed: true,
    }));

    expect(fixture.recovery[0]).toMatchObject({
      operation: 'void_market', attestation: { reason: 'cancelled', decidingSequence: 30n },
    });
    expect(fixture.signingKinds).toContain('void');
  });
});
