import type { MarketEffect, MarketState, MatchEvent, Position } from '@calledit/market-engine';
import { canonicalJson } from '@calledit/escrow-sdk';
import type { VoidReason } from '@calledit/escrow-sdk';
import type { Deps, MarketRow, PositionRow } from '../ports.js';
import type { EscrowOracleAttestationPolicy } from './attestation-signers.js';
import type { EscrowUnsignedWorkflowRequest } from './attestation-request-payload.js';
import type { EscrowAttestationRequestService } from './attestation-request-service.js';
import type {
  EscrowFinalizedProjection,
  EscrowFinalizedTransactionProjection,
} from './finalized-indexer.js';
import type { createEscrowRecoveryService } from './recovery-workflows.js';
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

export interface EscrowSettlementPosition {
  readonly ownerPubkey: string;
  readonly settlementProcessed: boolean;
}

export interface EscrowSettlementPositionPort {
  positions(input: {
    readonly marketId: string;
    readonly marketPda: string;
  }): Promise<readonly EscrowSettlementPosition[]>;
}

export interface EscrowSettlementEntitlementScheduler {
  afterSettlementFinalized(input: {
    readonly marketId: string;
    readonly marketPda: string;
    readonly positionCount: bigint;
  }): Promise<void>;
}

/** A terminal escrow state is authoritative only after the finalized indexer emits it. */
export type EscrowFinalizedTerminalProjection = Extract<
  EscrowFinalizedProjection,
  { readonly kind: 'settlement' }
>;

/**
 * Parent wiring uses this after the finalized projection is durably recorded
 * and before its cursor advances. It is the only path permitted to update
 * terminal market status, receipts, or cards for escrow custody.
 */
export interface EscrowFinalizedTerminalProjectionSink {
  afterFinalizedTransaction(transaction: EscrowFinalizedTransactionProjection): Promise<void>;
}

export function createEscrowSettlementEntitlementScheduler(options: {
  readonly positions: EscrowSettlementPositionPort;
  readonly recovery: Pick<ReturnType<typeof createEscrowRecoveryService>, 'enqueue'>;
}): EscrowSettlementEntitlementScheduler {
  return {
    async afterSettlementFinalized(input) {
      const positions = await options.positions.positions(input);
      const owners = new Set(positions.map((position) => position.ownerPubkey));
      if (owners.size !== positions.length || BigInt(positions.length) !== input.positionCount) {
        throw new TypeError('escrow settlement position projection mismatch');
      }
      for (const position of positions) {
        if (position.settlementProcessed) continue;
        const result = await options.recovery.enqueue({
          operation: 'calculate_position_entitlement',
          marketPda: input.marketPda,
          owner: position.ownerPubkey,
        });
        if (result.kind === 'blocked') {
          throw new TypeError('escrow entitlement recovery enqueue blocked');
        }
      }
    },
  };
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

const REPLAY_EVENT_ATTEMPTS = 5;
const REPLAY_EVENT_RETRY_BASE_MS = 500;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
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

  function oracleEvidenceEvent(event: MatchEvent): MatchEvent {
    const providerTsMs = (event as MatchEvent & { readonly providerTsMs?: unknown }).providerTsMs;
    return typeof providerTsMs === 'number' && Number.isSafeInteger(providerTsMs) && providerTsMs >= 0
      ? { ...event, tsMs: providerTsMs }
      : event;
  }

  function common(context: EscrowWorkflowMarketContext, event: MatchEvent) {
    return {
      deployment: options.deployment, market: context.binding, event: oracleEvidenceEvent(event),
      issuedAt: BigInt(Math.floor(event.receivedAtMs / 1_000)), ttlSeconds,
    };
  }

  async function persist(
    request: EscrowUnsignedWorkflowRequest,
    market: MarketRow,
    context: EscrowWorkflowMarketContext,
    event: MatchEvent,
    dueAtMs: number = event.receivedAtMs,
    debounceUntilIso: string | null = null,
  ): Promise<void> {
    await options.requests.enqueue({
      marketId: context.binding.marketId,
      documentHashHex: context.binding.marketDocumentHashHex,
      claimSpecificationJson: canonicalJson(market.spec),
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
      }, market, context, event);
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
      }, market, context, event);
    }
    options.deps.log.info('escrow_price_event_scheduled', { marketId: market.id, seq: event.seq });
  }

  async function applyEffect(
    effect: MarketEffect,
    market: MarketRow,
    context: EscrowWorkflowMarketContext,
    event: MatchEvent,
  ): Promise<void> {
    if (effect.kind === 'freeze' && context.chainState === 'open' && !isPriceMoving(event)) {
      const attestation = buildEscrowFeedEventAttestation({ ...common(context, event), eventKind: 'freeze' });
      await persist({
        operation: 'freeze_market', marketPda: context.binding.marketPda,
        expectedEventEpoch: context.binding.eventEpoch, attestation,
      }, market, context, event);
      return;
    }
    if (effect.kind === 'unfreeze' && context.chainState === 'frozen') {
      const attestation = buildEscrowFeedEventAttestation({ ...common(context, event), eventKind: 'unfreeze' });
      await persist({ operation: 'unfreeze_market', marketPda: context.binding.marketPda, attestation }, market, context, event);
      return;
    }
    if (effect.kind === 'settle') {
      if (effect.outcome === 'void') {
        const attestation = buildEscrowVoidAttestation({
          ...common(context, event), reason: 'undecidable', decidingSequence: effect.decidingSeq,
        });
        await persist({ operation: 'void_market', marketPda: context.binding.marketPda, attestation }, market, context, event);
        return;
      }
      const attestation = buildEscrowSettlementAttestation({
        ...common(context, event), outcome: effect.outcome,
        decidingSequence: effect.decidingSeq, evidenceSequences: effect.evidenceSeqs,
      });
      await persist({ operation: 'settle_market', marketPda: context.binding.marketPda, attestation }, market, context, event);
      return;
    }
    if (effect.kind === 'void') {
      const attestation = buildEscrowVoidAttestation({
        ...common(context, event), reason: voidReason(event), decidingSequence: event.seq,
      });
      await persist({ operation: 'void_market', marketPda: context.binding.marketPda, attestation }, market, context, event);
    }
  }

  async function persistNewPending(
    previous: MarketState['pendingSettlement'],
    current: MarketState['pendingSettlement'],
    market: MarketRow,
    context: EscrowWorkflowMarketContext,
    event: MatchEvent,
  ): Promise<void> {
    if (!pendingSettlementChanged(previous, current)) return;
    const debounceUntilIso = iso(current.debounceUntilMs);
    if (current.outcome === 'void') {
      const attestation = buildEscrowVoidAttestation({
        ...common(context, event), reason: 'undecidable', decidingSequence: current.decidingSeq,
      });
      await persist(
        { operation: 'void_market', marketPda: context.binding.marketPda, attestation },
        market, context, event, current.debounceUntilMs, debounceUntilIso,
      );
      return;
    }
    const attestation = buildEscrowSettlementAttestation({
      ...common(context, event), outcome: current.outcome,
      decidingSequence: current.decidingSeq, evidenceSequences: current.evidenceSeqs,
    });
    await persist(
      { operation: 'settle_market', marketPda: context.binding.marketPda, attestation },
      market, context, event, current.debounceUntilMs, debounceUntilIso,
    );
  }

  function pendingSettlementChanged(
    previous: MarketState['pendingSettlement'],
    current: MarketState['pendingSettlement'],
  ): current is NonNullable<MarketState['pendingSettlement']> {
    return current !== null && (
      previous === null || previous.decidingSeq !== current.decidingSeq ||
      previous.debounceUntilMs !== current.debounceUntilMs
    );
  }

  function requiresWorkflowContext(
    effects: readonly MarketEffect[],
    event: MatchEvent,
    previousPending: MarketState['pendingSettlement'],
    currentPending: MarketState['pendingSettlement'],
  ): boolean {
    if (isPriceMoving(event) || pendingSettlementChanged(previousPending, currentPending)) return true;
    return effects.some((effect) => (
      effect.kind === 'freeze' || effect.kind === 'unfreeze' ||
      effect.kind === 'settle' || effect.kind === 'void'
    ));
  }

  async function reduce(market: MarketRow, event: MatchEvent): Promise<void> {
    if (event.seq <= (eventWatermarks.get(market.id) ?? -1)) return;
    const state = await hydrate(market);
    const result = options.deps.engine.reduceMarket(state, event);
    if (result.state === state && result.effects.length === 0) return;
    if (requiresWorkflowContext(
      result.effects, event, state.pendingSettlement, result.state.pendingSettlement,
    )) {
      const context = await options.workflow.loadMarket(market);
      if (context === null || context.replay !== market.is_replay) return;
      await protectPriceMovingLots(market, context, event);
      for (const effect of result.effects) await applyEffect(effect, market, context, event);
      await persistNewPending(state.pendingSettlement, result.state.pendingSettlement, market, context, event);
    }
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
      const attempts = groupId === undefined ? 1 : REPLAY_EVENT_ATTEMPTS;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          await reduce(market, event);
          break;
        } catch (error) {
          states.delete(market.id);
          if (attempt < attempts) {
            options.deps.log.info('escrow_replay_event_retry', {
              marketId: market.id, seq: event.seq, attempt,
            });
            await wait(REPLAY_EVENT_RETRY_BASE_MS * attempt);
            continue;
          }
          options.deps.log.error('escrow_event_workflow_failed', {
            marketId: market.id,
            seq: event.seq,
            reason: error instanceof Error ? error.name : 'unknown_exception',
          });
          if (groupId !== undefined) throw error;
        }
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
