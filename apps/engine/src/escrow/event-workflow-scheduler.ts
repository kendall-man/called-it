import type { MarketEffect, MarketState, MatchEvent, Position } from '@calledit/market-engine';
import type { VoidReason } from '@calledit/escrow-sdk';
import type { Deps, MarketRow, PositionRow } from '../ports.js';
import type { EscrowOracleAttestationPolicy } from './attestation-signers.js';
import type { EscrowUnsignedWorkflowRequest } from './attestation-request-payload.js';
import type { EscrowAttestationRequestService } from './attestation-request-service.js';
import {
  buildEscrowFeedEventAttestation,
  buildEscrowPositionInvalidationAttestation,
  buildEscrowSettlementAttestation,
  buildEscrowVoidAttestation,
  type EscrowAttestationDeploymentBinding,
  type EscrowAttestationMarketBinding,
} from './event-attestations.js';

export interface EscrowWorkflowMarketContext {
  readonly binding: EscrowAttestationMarketBinding;
  readonly chainState: 'open' | 'frozen';
  readonly replay: boolean;
  readonly oraclePolicy: EscrowOracleAttestationPolicy;
}

export interface EscrowWorkflowPositionLot {
  readonly ownerPubkey: string;
  readonly lotNonce: bigint;
  readonly positionLotPda: string;
  readonly placedTimestamp: bigint;
  readonly observedEventEpoch: bigint;
  readonly activationTimestamp: bigint | null;
  readonly state: 'pending' | 'active';
}

export interface EscrowEventWorkflowPort {
  loadMarket(market: MarketRow): Promise<EscrowWorkflowMarketContext | null>;
  positionLots(context: EscrowWorkflowMarketContext): Promise<readonly EscrowWorkflowPositionLot[]>;
}

function position(row: PositionRow): Position {
  return {
    id: row.id, userId: String(row.user_id), side: row.side, stake: row.stake,
    lockedMultiplier: row.locked_multiplier, placedAtMs: row.placed_at_ms, state: row.state,
  };
}

function isPriceMoving(event: MatchEvent): boolean {
  return event.confirmed && (event.kind === 'goal' || (event.kind === 'card' && event.detail?.card === 'red'));
}

function voidReason(event: MatchEvent): VoidReason {
  if (event.phase === 'CAN') return 'cancelled';
  if (event.phase === 'ABD') return 'abandoned';
  if (event.phase === 'COV_LOST' || event.kind === 'coverage_warning') return 'coverage_loss';
  return 'undecidable';
}

function iso(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds)) throw new TypeError('invalid escrow workflow timestamp');
  return new Date(milliseconds).toISOString();
}

export function createEscrowEventWorkflowScheduler(options: {
  readonly deps: {
    readonly db: Pick<Deps['db'], 'openMarketsForFixture' | 'positionsForMarket'>;
    readonly engine: Pick<Deps['engine'], 'reduceMarket'>;
    readonly log: Pick<Deps['log'], 'info' | 'error'>;
  };
  readonly deployment: EscrowAttestationDeploymentBinding;
  readonly requests: Pick<EscrowAttestationRequestService, 'enqueue'>;
  readonly workflow: EscrowEventWorkflowPort;
  readonly attestationTtlSeconds?: bigint;
}) {
  const states = new Map<string, MarketState>();
  const eventWatermarks = new Map<string, number>();
  const ttlSeconds = options.attestationTtlSeconds ?? 300n;

  async function hydrate(market: MarketRow): Promise<MarketState> {
    const positions = (await options.deps.db.positionsForMarket(market.id)).map(position);
    const cached = states.get(market.id);
    if (cached !== undefined) return { ...cached, positions };
    return {
      marketId: market.id, spec: market.spec, status: market.status, positions,
      pendingSettlement: null, createdAtMs: Date.parse(market.created_at),
    };
  }

  function common(context: EscrowWorkflowMarketContext, event: MatchEvent) {
    return {
      deployment: options.deployment, market: context.binding, event,
      issuedAt: BigInt(Math.floor(event.receivedAtMs / 1_000)), ttlSeconds,
    };
  }

  async function persist(
    request: EscrowUnsignedWorkflowRequest,
    context: EscrowWorkflowMarketContext,
    event: MatchEvent,
    dueAtMs: number = event.receivedAtMs,
    debounceUntilIso: string | null = null,
  ): Promise<void> {
    await options.requests.enqueue({
      marketId: context.binding.marketId,
      documentHashHex: context.binding.marketDocumentHashHex,
      eventEpoch: context.binding.eventEpoch,
      replay: context.replay,
      oraclePolicy: context.oraclePolicy,
      request,
      dueAtIso: iso(dueAtMs),
      debounceUntilIso,
    });
  }

  async function protectPriceMovingLots(
    market: MarketRow,
    context: EscrowWorkflowMarketContext,
    event: MatchEvent,
  ): Promise<void> {
    if (!isPriceMoving(event)) return;
    const invalidatedEventEpoch = context.chainState === 'open'
      ? context.binding.eventEpoch + 1n : context.binding.eventEpoch;
    if (context.chainState === 'open') {
      const attestation = buildEscrowFeedEventAttestation({ ...common(context, event), eventKind: 'freeze' });
      await persist({
        operation: 'freeze_market', marketPda: context.binding.marketPda,
        expectedEventEpoch: context.binding.eventEpoch, attestation,
      }, context, event);
    }
    const lots = await options.workflow.positionLots(context);
    for (const lot of lots) {
      if (
        lot.activationTimestamp === null || lot.observedEventEpoch >= invalidatedEventEpoch ||
        lot.placedTimestamp * 1_000n <= BigInt(event.tsMs)
      ) continue;
      const attestation = buildEscrowPositionInvalidationAttestation({
        ...common(context, event), ownerPubkey: lot.ownerPubkey, lotNonce: lot.lotNonce,
        positionLotPda: lot.positionLotPda, observedEventEpoch: lot.observedEventEpoch,
        invalidatedEventEpoch,
      });
      await persist({
        operation: 'invalidate_position_lot', marketPda: context.binding.marketPda,
        owner: lot.ownerPubkey, lotNonce: lot.lotNonce, positionLotPda: lot.positionLotPda, attestation,
      }, context, event);
    }
    options.deps.log.info('escrow_price_event_scheduled', { marketId: market.id, seq: event.seq });
  }

  async function applyEffect(
    effect: MarketEffect,
    context: EscrowWorkflowMarketContext,
    event: MatchEvent,
  ): Promise<void> {
    if (effect.kind === 'freeze' && context.chainState === 'open' && !isPriceMoving(event)) {
      const attestation = buildEscrowFeedEventAttestation({ ...common(context, event), eventKind: 'freeze' });
      await persist({
        operation: 'freeze_market', marketPda: context.binding.marketPda,
        expectedEventEpoch: context.binding.eventEpoch, attestation,
      }, context, event);
      return;
    }
    if (effect.kind === 'unfreeze' && context.chainState === 'frozen') {
      const attestation = buildEscrowFeedEventAttestation({ ...common(context, event), eventKind: 'unfreeze' });
      await persist({ operation: 'unfreeze_market', marketPda: context.binding.marketPda, attestation }, context, event);
      return;
    }
    if (effect.kind === 'settle') {
      if (effect.outcome === 'void') {
        const attestation = buildEscrowVoidAttestation({
          ...common(context, event), reason: 'undecidable', decidingSequence: effect.decidingSeq,
        });
        await persist({ operation: 'void_market', marketPda: context.binding.marketPda, attestation }, context, event);
        return;
      }
      const attestation = buildEscrowSettlementAttestation({
        ...common(context, event), outcome: effect.outcome,
        decidingSequence: effect.decidingSeq, evidenceSequences: effect.evidenceSeqs,
      });
      await persist({ operation: 'settle_market', marketPda: context.binding.marketPda, attestation }, context, event);
      return;
    }
    if (effect.kind === 'void') {
      const attestation = buildEscrowVoidAttestation({
        ...common(context, event), reason: voidReason(event), decidingSequence: event.seq,
      });
      await persist({ operation: 'void_market', marketPda: context.binding.marketPda, attestation }, context, event);
    }
  }

  async function persistNewPending(
    previous: MarketState['pendingSettlement'],
    current: MarketState['pendingSettlement'],
    context: EscrowWorkflowMarketContext,
    event: MatchEvent,
  ): Promise<void> {
    if (
      current === null ||
      (previous !== null && previous.decidingSeq === current.decidingSeq &&
        previous.debounceUntilMs === current.debounceUntilMs)
    ) return;
    const debounceUntilIso = iso(current.debounceUntilMs);
    if (current.outcome === 'void') {
      const attestation = buildEscrowVoidAttestation({
        ...common(context, event), reason: 'undecidable', decidingSequence: current.decidingSeq,
      });
      await persist(
        { operation: 'void_market', marketPda: context.binding.marketPda, attestation },
        context, event, current.debounceUntilMs, debounceUntilIso,
      );
      return;
    }
    const attestation = buildEscrowSettlementAttestation({
      ...common(context, event), outcome: current.outcome,
      decidingSequence: current.decidingSeq, evidenceSequences: current.evidenceSeqs,
    });
    await persist(
      { operation: 'settle_market', marketPda: context.binding.marketPda, attestation },
      context, event, current.debounceUntilMs, debounceUntilIso,
    );
  }

  async function reduce(market: MarketRow, event: MatchEvent): Promise<void> {
    if (event.seq <= (eventWatermarks.get(market.id) ?? -1)) return;
    const context = await options.workflow.loadMarket(market);
    if (context === null || context.replay !== market.is_replay) return;
    const state = await hydrate(market);
    const result = options.deps.engine.reduceMarket(state, event);
    if (result.state === state && result.effects.length === 0) return;
    await protectPriceMovingLots(market, context, event);
    for (const effect of result.effects) await applyEffect(effect, context, event);
    await persistNewPending(state.pendingSettlement, result.state.pendingSettlement, context, event);
    eventWatermarks.set(market.id, event.seq);
    if (result.state.status === 'settled' || result.state.status === 'voided') states.delete(market.id);
    else states.set(market.id, result.state);
  }

  async function matchingMarkets(event: MatchEvent, groupId?: number, replayStartedAtMs?: number) {
    return (await options.deps.db.openMarketsForFixture(event.fixtureId)).filter((market) =>
      market.custody_mode === 'escrow' && (groupId === undefined
        ? !market.is_replay
        : market.is_replay && market.group_id === groupId &&
          Date.parse(market.created_at) >= (replayStartedAtMs ?? Number.NEGATIVE_INFINITY))
    );
  }

  async function run(event: MatchEvent, groupId?: number, replayStartedAtMs?: number): Promise<void> {
    for (const market of await matchingMarkets(event, groupId, replayStartedAtMs)) {
      try {
        await reduce(market, event);
      } catch (error) {
        states.delete(market.id);
        options.deps.log.error('escrow_event_workflow_failed', { marketId: market.id, seq: event.seq });
        if (groupId !== undefined) throw error;
      }
    }
  }

  return {
    onEvent: (event: MatchEvent) => run(event),
    onReplayEvent: (groupId: number, event: MatchEvent, replayStartedAtMs?: number) =>
      run(event, groupId, replayStartedAtMs),
    async tick(_nowMs: number) {},
  };
}

export type EscrowEventWorkflowScheduler = ReturnType<typeof createEscrowEventWorkflowScheduler>;
