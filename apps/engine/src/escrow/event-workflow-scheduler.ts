import type {
  MarketEffect,
  MarketState,
  MatchEvent,
  Position,
} from '@calledit/market-engine';
import type { VoidReason } from '@calledit/escrow-sdk';
import type { Deps, MarketRow, PositionRow } from '../ports.js';
import type { EscrowOracleAttestationProvider } from './attestation-signers.js';
import type { EscrowOracleAttestationPolicy } from './attestation-signers.js';
import type { EscrowControlRequest } from './control-workflows.js';
import {
  buildEscrowFeedEventAttestation,
  buildEscrowPositionInvalidationAttestation,
  buildEscrowSettlementAttestation,
  buildEscrowVoidAttestation,
  type EscrowAttestationDeploymentBinding,
  type EscrowAttestationMarketBinding,
} from './event-attestations.js';
import type { EscrowRecoveryRequest } from './recovery-workflows.js';

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
  enqueueControl(request: EscrowControlRequest): Promise<void>;
  enqueueRecovery(request: EscrowRecoveryRequest): Promise<void>;
}

type UnsignedControlRequest = EscrowControlRequest extends infer Request
  ? Request extends EscrowControlRequest ? Omit<Request, 'signatures'> : never
  : never;

function position(row: PositionRow): Position {
  return {
    id: row.id,
    userId: String(row.user_id),
    side: row.side,
    stake: row.stake,
    lockedMultiplier: row.locked_multiplier,
    placedAtMs: row.placed_at_ms,
    state: row.state,
  };
}

function isPriceMoving(event: MatchEvent): boolean {
  return event.confirmed && (
    event.kind === 'goal' || (event.kind === 'card' && event.detail?.card === 'red')
  );
}

function voidReason(event: MatchEvent): VoidReason {
  if (event.phase === 'CAN') return 'cancelled';
  if (event.phase === 'ABD') return 'abandoned';
  if (event.phase === 'COV_LOST' || event.kind === 'coverage_warning') return 'coverage_loss';
  return 'undecidable';
}

export function createEscrowEventWorkflowScheduler(options: {
  readonly deps: Pick<Deps, 'db' | 'engine' | 'log'>;
  readonly allowedGroupIds: readonly number[];
  readonly deployment: EscrowAttestationDeploymentBinding;
  readonly oracle: EscrowOracleAttestationProvider;
  readonly workflow: EscrowEventWorkflowPort;
  readonly clock: () => bigint;
  readonly attestationTtlSeconds?: bigint;
}) {
  const states = new Map<string, MarketState>();
  const lastEvents = new Map<string, MatchEvent>();
  const allowedGroups = new Set(options.allowedGroupIds);
  const ttlSeconds = options.attestationTtlSeconds ?? 300n;

  async function hydrate(market: MarketRow): Promise<MarketState> {
    const positions = (await options.deps.db.positionsForMarket(market.id)).map(position);
    const cached = states.get(market.id);
    if (cached !== undefined) return { ...cached, positions };
    return {
      marketId: market.id,
      spec: market.spec,
      status: market.status,
      positions,
      pendingSettlement: null,
      createdAtMs: Date.parse(market.created_at),
    };
  }

  function common(context: EscrowWorkflowMarketContext, event: MatchEvent) {
    return {
      deployment: options.deployment,
      market: context.binding,
      event,
      issuedAt: options.clock(),
      ttlSeconds,
    };
  }

  async function signedControl(
    request: UnsignedControlRequest,
    signingRequest: Parameters<EscrowOracleAttestationProvider['sign']>[0],
    policy: EscrowOracleAttestationPolicy,
  ): Promise<void> {
    const signatures = await options.oracle.sign(signingRequest, policy);
    await options.workflow.enqueueControl({ ...request, signatures } as EscrowControlRequest);
  }

  async function protectPriceMovingLots(
    market: MarketRow,
    context: EscrowWorkflowMarketContext,
    event: MatchEvent,
  ): Promise<void> {
    if (!isPriceMoving(event)) return;
    const invalidatedEventEpoch = context.chainState === 'open'
      ? context.binding.eventEpoch + 1n
      : context.binding.eventEpoch;
    if (context.chainState === 'open') {
      const attestation = buildEscrowFeedEventAttestation({
        ...common(context, event), eventKind: 'freeze',
      });
      await signedControl({
        operation: 'freeze_market', marketPda: context.binding.marketPda,
        expectedEventEpoch: context.binding.eventEpoch, attestation,
      }, { kind: 'feed_event', attestation }, context.oraclePolicy);
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
      await signedControl({
        operation: 'invalidate_position_lot', marketPda: context.binding.marketPda,
        owner: lot.ownerPubkey, lotNonce: lot.lotNonce,
        positionLotPda: lot.positionLotPda, attestation,
      }, { kind: 'position_invalidation', attestation }, context.oraclePolicy);
    }
    options.deps.log.info('escrow_price_event_scheduled', {
      marketId: market.id, seq: event.seq,
    });
  }

  async function applyEffect(
    effect: MarketEffect,
    context: EscrowWorkflowMarketContext,
    event: MatchEvent,
  ): Promise<void> {
    if (effect.kind === 'freeze' && context.chainState === 'open' && !isPriceMoving(event)) {
      const attestation = buildEscrowFeedEventAttestation({
        ...common(context, event), eventKind: 'freeze',
      });
      await signedControl({
        operation: 'freeze_market', marketPda: context.binding.marketPda,
        expectedEventEpoch: context.binding.eventEpoch, attestation,
      }, { kind: 'feed_event', attestation }, context.oraclePolicy);
      return;
    }
    if (effect.kind === 'unfreeze' && context.chainState === 'frozen') {
      const attestation = buildEscrowFeedEventAttestation({
        ...common(context, event), eventKind: 'unfreeze',
      });
      await signedControl({
        operation: 'unfreeze_market', marketPda: context.binding.marketPda, attestation,
      }, { kind: 'feed_event', attestation }, context.oraclePolicy);
      return;
    }
    if (effect.kind === 'settle') {
      if (effect.outcome === 'void') {
        const attestation = buildEscrowVoidAttestation({
          ...common(context, event), reason: 'undecidable', decidingSequence: effect.decidingSeq,
        });
        const signatures = await options.oracle.sign({ kind: 'void', attestation }, context.oraclePolicy);
        await options.workflow.enqueueRecovery({
          operation: 'void_market', marketPda: context.binding.marketPda, attestation, signatures,
        });
        return;
      }
      const attestation = buildEscrowSettlementAttestation({
        ...common(context, event), outcome: effect.outcome,
        decidingSequence: effect.decidingSeq, evidenceSequences: effect.evidenceSeqs,
      });
      const signatures = await options.oracle.sign({ kind: 'settlement', attestation }, context.oraclePolicy);
      await options.workflow.enqueueRecovery({
        operation: 'settle_market', marketPda: context.binding.marketPda, attestation, signatures,
      });
      return;
    }
    if (effect.kind === 'void') {
      const attestation = buildEscrowVoidAttestation({
        ...common(context, event), reason: voidReason(event), decidingSequence: event.seq,
      });
      const signatures = await options.oracle.sign({ kind: 'void', attestation }, context.oraclePolicy);
      await options.workflow.enqueueRecovery({
        operation: 'void_market', marketPda: context.binding.marketPda, attestation, signatures,
      });
    }
  }

  async function reduce(market: MarketRow, event: MatchEvent): Promise<void> {
    const context = await options.workflow.loadMarket(market);
    if (context === null || context.replay !== market.is_replay) return;
    const state = await hydrate(market);
    const result = options.deps.engine.reduceMarket(state, event);
    await protectPriceMovingLots(market, context, event);
    for (const effect of result.effects) await applyEffect(effect, context, event);
    lastEvents.set(market.id, event);
    if (result.state.status === 'settled' || result.state.status === 'voided') {
      states.delete(market.id);
      lastEvents.delete(market.id);
    } else {
      states.set(market.id, result.state);
    }
  }

  async function matchingMarkets(event: MatchEvent, groupId?: number, replayStartedAtMs?: number) {
    return (await options.deps.db.openMarketsForFixture(event.fixtureId)).filter((market) =>
      allowedGroups.has(market.group_id) &&
      (groupId === undefined
        ? !market.is_replay
        : market.is_replay && market.group_id === groupId && Date.parse(market.created_at) >= (replayStartedAtMs ?? Number.NEGATIVE_INFINITY))
    );
  }

  async function run(event: MatchEvent, groupId?: number, replayStartedAtMs?: number): Promise<void> {
    for (const market of await matchingMarkets(event, groupId, replayStartedAtMs)) {
      try {
        await reduce(market, event);
      } catch (error) {
        states.delete(market.id);
        lastEvents.delete(market.id);
        options.deps.log.error('escrow_event_workflow_failed', { marketId: market.id, seq: event.seq });
        if (groupId !== undefined) throw error;
      }
    }
  }

  return {
    onEvent: (event: MatchEvent) => run(event),
    onReplayEvent: (groupId: number, event: MatchEvent, replayStartedAtMs?: number) =>
      run(event, groupId, replayStartedAtMs),
    async tick(nowMs: number) {
      for (const [marketId, state] of [...states]) {
        if (state.pendingSettlement === null) continue;
        const event = lastEvents.get(marketId);
        const market = await options.deps.db.getMarket(marketId);
        if (event === undefined || market === null) continue;
        const context = await options.workflow.loadMarket(market);
        if (context === null) continue;
        const result = options.deps.engine.checkDebounce(state, nowMs);
        for (const effect of result.effects) await applyEffect(effect, context, event);
        if (result.state.status === 'settled' || result.state.status === 'voided') {
          states.delete(marketId);
          lastEvents.delete(marketId);
        } else {
          states.set(marketId, result.state);
        }
      }
    },
  };
}

export type EscrowEventWorkflowScheduler = ReturnType<typeof createEscrowEventWorkflowScheduler>;
