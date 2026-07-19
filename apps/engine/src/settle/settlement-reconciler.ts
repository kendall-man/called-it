import {
  isWagerAsset,
  TERMINAL_PHASES,
  TUNABLES,
  VOID_PHASES,
  type MarketEffect,
  type MarketState,
  type MatchEvent,
  type Position,
} from '@calledit/market-engine';
import type { Deps, EngineDb, FixtureRow, MarketRow, PositionRow } from '../ports.js';
import type { EnginePort } from '../ports/services.js';
import type { Logger } from '../log.js';
import { ENGINE } from '../engineConstants.js';

type ReconciliationDb = Pick<
  EngineDb,
  | 'liveFixtures'
  | 'openMarketsForFixture'
  | 'positionsForMarket'
  | 'insertFeedEvent'
  | 'updateFixtureFromEvent'
  | 'updateMarketStatus'
  | 'insertSettlement'
>;

type TerminalEffect = Extract<MarketEffect, { kind: 'settle' | 'void' }>;

export interface SettlementReconcilerOptions {
  readonly db: ReconciliationDb;
  readonly fetchScoreEvents: (fixtureId: number) => Promise<readonly MatchEvent[]>;
  readonly reduceMarket: EnginePort['reduceMarket'];
  readonly checkDebounce: EnginePort['checkDebounce'];
  readonly applySettlement: ((marketId: string) => Promise<void>) | null;
  /** Best-effort immediate terminal card edit; the receipt sweeper remains recovery. */
  readonly presentTerminal?: (market: MarketRow) => Promise<void>;
  readonly log: Pick<Logger, 'info' | 'warn' | 'error'>;
  readonly now: () => number;
  readonly lookaheadMs: number;
}

interface MarketWithPositions {
  readonly market: MarketRow;
  readonly positions: readonly PositionRow[];
}

function toPosition(row: PositionRow): Position {
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

function isTerminalEvent(event: MatchEvent): boolean {
  return TERMINAL_PHASES.includes(event.phase) || VOID_PHASES.includes(event.phase);
}

function terminalEffect(effects: readonly MarketEffect[]): TerminalEffect | null {
  return effects.find((effect): effect is TerminalEffect =>
    effect.kind === 'settle' || effect.kind === 'void') ?? null;
}

async function marketsWithPositions(
  db: ReconciliationDb,
  fixture: FixtureRow,
): Promise<readonly MarketWithPositions[]> {
  const markets = (await db.openMarketsForFixture(fixture.fixture_id))
    .filter((market) => isWagerAsset(market.currency));
  const candidates: MarketWithPositions[] = [];
  for (const market of markets) {
    const positions = await db.positionsForMarket(market.id);
    if (positions.length > 0) candidates.push({ market, positions });
  }
  return candidates;
}

export class SettlementReconciler {
  private heartbeatAtMs: number | null = null;
  private backlog = 0;
  private watchedFixtures = 0;
  private readonly reconciledMarketIds = new Set<string>();
  private isRunning = false;

  constructor(private readonly options: SettlementReconcilerOptions) {}

  async tick(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      const fixtures = await this.options.db.liveFixtures(
        this.options.now(),
        this.options.lookaheadMs,
      );
      this.watchedFixtures = 0;
      this.backlog = 0;
      for (const fixture of fixtures) {
        const candidates = await marketsWithPositions(this.options.db, fixture);
        if (candidates.length === 0) continue;
        this.watchedFixtures += 1;
        const events = [...await this.options.fetchScoreEvents(fixture.fixture_id)]
          .sort((left, right) => left.seq - right.seq);
        if (!events.some(isTerminalEvent)) {
          for (const event of events) await this.options.db.insertFeedEvent(event);
          const latest = events.at(-1);
          if (latest !== undefined) await this.options.db.updateFixtureFromEvent(latest);
          continue;
        }
        this.backlog += candidates.length;
        for (const candidate of candidates) {
          await this.reconcileMarket(candidate, events);
          this.backlog -= 1;
        }
      }
      this.heartbeatAtMs = this.options.now();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      this.backlog = Math.max(1, this.backlog);
      this.options.log.error('settlement_reconciliation_failed');
    } finally {
      this.isRunning = false;
    }
  }

  async feedSnapshot(signal?: AbortSignal): Promise<{
    readonly activePricingExpected: boolean;
    readonly lastEventAtMs: number | null;
  }> {
    signal?.throwIfAborted();
    return {
      activePricingExpected: this.watchedFixtures > 0,
      lastEventAtMs: this.watchedFixtures > 0 ? this.heartbeatAtMs : null,
    };
  }

  async snapshot(signal?: AbortSignal): Promise<{
    readonly enabled: true;
    readonly heartbeatAtMs: number | null;
    readonly backlog: number;
    readonly oldestAgeMs: null;
  }> {
    signal?.throwIfAborted();
    return {
      enabled: true,
      heartbeatAtMs: this.heartbeatAtMs,
      backlog: this.backlog,
      oldestAgeMs: null,
    };
  }

  private async reconcileMarket(
    candidate: MarketWithPositions,
    events: readonly MatchEvent[],
  ): Promise<void> {
    if (this.reconciledMarketIds.has(candidate.market.id)) return;
    let state: MarketState = {
      marketId: candidate.market.id,
      spec: candidate.market.spec,
      status: candidate.market.status,
      positions: candidate.positions.map(toPosition),
      pendingSettlement: null,
      createdAtMs: Date.parse(candidate.market.created_at),
    };
    for (const event of events) {
      await this.options.db.insertFeedEvent(event);
      const result = this.options.reduceMarket(state, event);
      state = result.state;
      const effect = terminalEffect(result.effects);
      if (effect === null) continue;
      await this.persistTerminal(candidate.market, event, effect);
      return;
    }
    const result = this.options.checkDebounce(
      state,
      this.options.now() + TUNABLES.SETTLEMENT_DEBOUNCE_MS,
    );
    const effect = terminalEffect(result.effects);
    if (effect !== null) {
      const decidingEvent = events.find((event) =>
        effect.kind === 'settle' && event.seq === effect.decidingSeq) ?? events.at(-1);
      if (decidingEvent !== undefined) {
        await this.persistTerminal(candidate.market, decidingEvent, effect);
      }
    }
  }

  private async persistTerminal(
    market: MarketRow,
    event: MatchEvent,
    effect: TerminalEffect,
  ): Promise<void> {
    const outcome = effect.kind === 'settle' ? effect.outcome : 'void';
    const decidingSeq = effect.kind === 'settle' ? effect.decidingSeq : event.seq;
    const evidenceSeqs = effect.kind === 'settle' ? effect.evidenceSeqs : [];
    await this.options.db.updateFixtureFromEvent(event);
    await this.options.db.updateMarketStatus(market.id, outcome === 'void' ? 'voided' : 'settled');
    await this.options.db.insertSettlement({
      market_id: market.id,
      outcome,
      deciding_seq: decidingSeq,
      evidence_seqs: evidenceSeqs,
      tier: market.spec.trustTier,
    });
    await this.options.applySettlement?.(market.id);
    try {
      await this.options.presentTerminal?.(market);
    } catch {
      this.options.log.warn('settlement_terminal_presentation_failed', { marketId: market.id });
    }
    this.reconciledMarketIds.add(market.id);
    this.options.log.info('settlement_reconciled', {
      marketId: market.id,
      fixtureId: market.fixture_id,
      outcome,
      decidingSeq,
    });
  }
}

export function createSettlementReconciler(
  deps: Deps,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
  presentTerminal?: (market: MarketRow) => Promise<void>,
): SettlementReconciler {
  return new SettlementReconciler({
    db: deps.db,
    fetchScoreEvents: deps.tx.fetchScoreEvents,
    reduceMarket: deps.engine.reduceMarket,
    checkDebounce: deps.engine.checkDebounce,
    applySettlement: deps.wager?.applySettlement ?? null,
    ...(presentTerminal === undefined ? {} : { presentTerminal }),
    log,
    now: deps.now,
    lookaheadMs: ENGINE.LIVE_LOOKAHEAD_MS,
  });
}
