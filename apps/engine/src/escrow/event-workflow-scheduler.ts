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
  /** Proves every durable placement has reached the finalized lot projection. */
  positionProjectionComplete?(context: EscrowWorkflowMarketContext): Promise<boolean>;
  /** Recovery must resume one durable terminal decision, never mint a competing envelope. */
  terminalAttestationExists?(marketId: string): Promise<boolean>;
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

type TerminalMarketEffect = Extract<MarketEffect, { readonly kind: 'settle' | 'void' }>;

type EscrowWorkflowFailureReason =
  | 'rpc_unavailable'
  | 'projection_unavailable'
  | 'chain_identity_mismatch'
  | 'attestation_storage_unavailable'
  | 'workflow_validation_failed'
  | 'unknown_exception';

class EscrowWorkflowBoundaryError extends Error {
  constructor(readonly reason: EscrowWorkflowFailureReason) {
    super(reason);
    this.name = 'EscrowWorkflowBoundaryError';
  }
}

function workflowFailureReason(error: unknown): EscrowWorkflowFailureReason {
  if (error instanceof EscrowWorkflowBoundaryError) return error.reason;
  if (!(error instanceof Error)) return 'unknown_exception';
  const message = error.message.toLowerCase();
  if (message.includes('identity') || message.includes('market link mismatch')) {
    return 'chain_identity_mismatch';
  }
  if (message.includes('projection')) return 'projection_unavailable';
  if (message.includes('storage') || message.includes('attestation')) {
    return 'attestation_storage_unavailable';
  }
  if (
    message.includes('rpc') || message.includes('429') || message.includes('network') ||
    message.includes('fetch') || message.includes('transient')
  ) return 'rpc_unavailable';
  return error instanceof TypeError ? 'workflow_validation_failed' : 'unknown_exception';
}

export function createEscrowEventWorkflowScheduler(options: {
  readonly deps: {
    readonly db: Pick<Deps['db'], 'openMarketsForFixture' | 'positionsForMarket'>;
    readonly engine: Pick<Deps['engine'], 'reduceMarket' | 'checkDebounce'>;
    readonly log: Pick<Deps['log'], 'info' | 'error'>;
  };
  readonly deployment: EscrowAttestationDeploymentBinding;
  readonly requests: Pick<EscrowAttestationRequestService, 'enqueue'>;
  readonly workflow: EscrowEventWorkflowPort;
  readonly attestationTtlSeconds?: bigint;
}) {
  const states = new Map<string, MarketState>();
  const eventWatermarks = new Map<string, number>();
  const latestReplayEvents = new Map<string, MatchEvent>();
  // Replay terminal effects are held until EOF. A replay can finish much
  // faster than the on-chain anti-snipe activation delay, so submitting a
  // settlement candidate while a just-signed lot is still pending could close
  // the market around that lot. EOF makes the terminal decision once, against
  // the finalized lot state.
  const deferredReplayTerminals = new Map<string, TerminalMarketEffect>();
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
    try {
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
    } catch {
      throw new EscrowWorkflowBoundaryError('attestation_storage_unavailable');
    }
  }

  function sameMarketBinding(
    left: EscrowAttestationMarketBinding,
    right: EscrowAttestationMarketBinding,
  ): boolean {
    return left.marketId === right.marketId && left.marketPda === right.marketPda &&
      left.marketDocumentHashHex === right.marketDocumentHashHex &&
      left.fixtureId === right.fixtureId && left.oracleSetEpoch === right.oracleSetEpoch;
  }

  async function persistControl(
    request: Extract<EscrowUnsignedWorkflowRequest, { readonly operation: 'freeze_market' | 'unfreeze_market' }>,
    market: MarketRow,
    context: EscrowWorkflowMarketContext,
    event: MatchEvent,
  ): Promise<void> {
    try {
      await persist(request, market, context, event);
    } catch (error) {
      const refreshed = await options.workflow.loadMarket(market);
      const targetEpoch = context.binding.eventEpoch + 1n;
      const targetState = request.operation === 'freeze_market' ? 'frozen' : 'open';
      const alreadyFinalized = refreshed !== null && refreshed.replay === context.replay &&
        sameMarketBinding(refreshed.binding, context.binding) &&
        (refreshed.binding.eventEpoch > targetEpoch || (
          refreshed.binding.eventEpoch === targetEpoch && refreshed.chainState === targetState
        ));
      if (!alreadyFinalized) throw error;
      options.deps.log.info('escrow_control_transition_already_finalized', {
        marketId: market.id,
        seq: event.seq,
        operation: request.operation,
        eventEpoch: refreshed.binding.eventEpoch.toString(),
      });
    }
  }

  async function protectPriceMovingLots(
    market: MarketRow,
    context: EscrowWorkflowMarketContext,
    event: MatchEvent,
    knownLots?: readonly EscrowWorkflowPositionLot[],
  ): Promise<void> {
    if (!isPriceMoving(event)) return;
    const lots = knownLots ?? await options.workflow.positionLots(context);
    if (context.replay && lots.length === 0) {
      options.deps.log.info('escrow_replay_control_skipped_empty_market', {
        marketId: market.id,
        seq: event.seq,
      });
      return;
    }
    const invalidatedEventEpoch = context.chainState === 'open'
      ? context.binding.eventEpoch + 1n : context.binding.eventEpoch;
    if (context.chainState === 'open') {
      const attestation = buildEscrowFeedEventAttestation({ ...common(context, event), eventKind: 'freeze' });
      await persistControl({
        operation: 'freeze_market', marketPda: context.binding.marketPda,
        expectedEventEpoch: context.binding.eventEpoch, attestation,
      }, market, context, event);
    }
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
    scheduleControls: boolean,
  ): Promise<void> {
    if ((effect.kind === 'freeze' || effect.kind === 'unfreeze') && !scheduleControls) return;
    if (effect.kind === 'freeze' && context.chainState === 'open' && !isPriceMoving(event)) {
      const attestation = buildEscrowFeedEventAttestation({ ...common(context, event), eventKind: 'freeze' });
      await persistControl({
        operation: 'freeze_market', marketPda: context.binding.marketPda,
        expectedEventEpoch: context.binding.eventEpoch, attestation,
      }, market, context, event);
      return;
    }
    if (effect.kind === 'unfreeze' && context.chainState === 'frozen') {
      const attestation = buildEscrowFeedEventAttestation({ ...common(context, event), eventKind: 'unfreeze' });
      await persistControl(
        { operation: 'unfreeze_market', marketPda: context.binding.marketPda, attestation },
        market, context, event,
      );
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
    // Odds events use epoch milliseconds as seq; score events use a small provider sequence.
    const usesScoreSequence = event.kind !== 'odds_suspension';
    if (usesScoreSequence && event.seq <= (eventWatermarks.get(market.id) ?? -1)) return;
    if (market.is_replay && usesScoreSequence) latestReplayEvents.set(market.id, event);
    const state = await hydrate(market);
    const result = options.deps.engine.reduceMarket(state, event);
    if (result.state === state && result.effects.length === 0) return;
    if (requiresWorkflowContext(
      result.effects, event, state.pendingSettlement, result.state.pendingSettlement,
    )) {
      const context = await options.workflow.loadMarket(market);
      if (context === null || context.replay !== market.is_replay) return;
      const replayLots = context.replay ? await options.workflow.positionLots(context) : undefined;
      const scheduleControls = replayLots === undefined || replayLots.length > 0;
      await protectPriceMovingLots(market, context, event, replayLots);
      for (const effect of result.effects) {
        if (context.replay && (effect.kind === 'settle' || effect.kind === 'void')) {
          deferredReplayTerminals.set(market.id, effect);
          continue;
        }
        await applyEffect(effect, market, context, event, scheduleControls);
      }
      // Replay terminals are emitted exactly once at EOF, after inspecting
      // finalized lots. Live markets retain the normal durable candidate path.
      if (!context.replay) {
        await persistNewPending(state.pendingSettlement, result.state.pendingSettlement, market, context, event);
      }
    }
    if (usesScoreSequence) eventWatermarks.set(market.id, event.seq);
    // Keep terminal state until the finalized projection closes the DB row.
    // Replay drains can contain multiple post-whistle records; rehydrating the
    // still-open DB row here would enqueue the same terminal transition again.
    states.set(market.id, result.state);
  }

  async function matchingMarkets(fixtureId: number, groupId?: number, replayStartedAtMs?: number) {
    return (await options.deps.db.openMarketsForFixture(fixtureId)).filter((market) =>
      market.fixture_id === fixtureId && market.custody_mode === 'escrow' && (groupId === undefined
        ? !market.is_replay
        : market.is_replay && market.group_id === groupId &&
          Date.parse(market.created_at) >= (replayStartedAtMs ?? Number.POSITIVE_INFINITY))
    );
  }

  async function run(
    event: MatchEvent,
    groupId?: number,
    replayStartedAtMs?: number,
    continueOnMarketFailure = false,
  ): Promise<void> {
    for (const market of await matchingMarkets(event.fixtureId, groupId, replayStartedAtMs)) {
      try {
        // A deterministic replay gets one persistence attempt per event. Retry
        // sleeps make 20x playback depend on wall-clock provider failures.
        await reduce(market, event);
      } catch (error) {
        options.deps.log.error('escrow_event_workflow_failed', {
          marketId: market.id,
          seq: event.seq,
          reason: workflowFailureReason(error),
        });
        if (groupId !== undefined && !continueOnMarketFailure) throw error;
      }
    }
  }

  async function finalizeReplay(
    groupId: number,
    fixtureId: number,
    replayStartedAtMs: number,
    continueOnMarketFailure = false,
  ): Promise<void> {
    if (!Number.isFinite(replayStartedAtMs)) return;
    for (const market of await matchingMarkets(fixtureId, groupId, replayStartedAtMs)) {
      try {
        let effect = deferredReplayTerminals.get(market.id);
        const event = latestReplayEvents.get(market.id);
        const state = states.get(market.id);
        if (effect === undefined && state?.pendingSettlement !== null && state?.pendingSettlement !== undefined) {
          effect = options.deps.engine
            .checkDebounce(state, state.pendingSettlement.debounceUntilMs)
            .effects.find((candidate): candidate is TerminalMarketEffect => (
              candidate.kind === 'settle' || candidate.kind === 'void'
            ));
        }
        if (effect === undefined || event === undefined) continue;
        if (
          continueOnMarketFailure &&
          options.workflow.terminalAttestationExists !== undefined &&
          await options.workflow.terminalAttestationExists(market.id)
        ) {
          deferredReplayTerminals.delete(market.id);
          latestReplayEvents.delete(market.id);
          continue;
        }
        const context = await options.workflow.loadMarket(market);
        if (context === null || !context.replay) continue;
        if (
          options.workflow.positionProjectionComplete !== undefined &&
          !(await options.workflow.positionProjectionComplete(context))
        ) {
          throw new TypeError('escrow placement projection incomplete');
        }
        const lots = await options.workflow.positionLots(context);
        const terminal = lots.some((lot) => lot.state === 'pending')
          ? { kind: 'void' as const, reason: 'replay_pending_activation_at_eof' }
          : effect;
        await applyEffect(terminal, market, context, event, false);
        if (terminal.kind === 'void' && terminal !== effect) {
          options.deps.log.info('escrow_replay_terminal_voided_pending_position', {
            marketId: market.id,
            pendingLots: lots.filter((lot) => lot.state === 'pending').length,
          });
        }
        deferredReplayTerminals.delete(market.id);
        latestReplayEvents.delete(market.id);
      } catch (error) {
        options.deps.log.error('escrow_replay_finalization_failed', {
          marketId: market.id,
          reason: workflowFailureReason(error),
        });
        if (!continueOnMarketFailure) throw error;
      }
    }
  }

  return {
    onEvent: (event: MatchEvent) => run(event),
    onReplayEvent: (groupId: number, event: MatchEvent, replayStartedAtMs: number) => {
      if (!Number.isFinite(replayStartedAtMs)) return Promise.resolve();
      return run(event, groupId, replayStartedAtMs);
    },
    finalizeReplay: (groupId: number, fixtureId: number, replayStartedAtMs: number) =>
      finalizeReplay(groupId, fixtureId, replayStartedAtMs),
    onReplayRecoveryEvent: (groupId: number, event: MatchEvent) =>
      run(event, groupId, 0, true),
    finalizeReplayRecovery: (groupId: number, fixtureId: number) =>
      finalizeReplay(groupId, fixtureId, 0, true),
    async tick(_nowMs: number) {},
  };
}

export type EscrowEventWorkflowScheduler = ReturnType<typeof createEscrowEventWorkflowScheduler>;
