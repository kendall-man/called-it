import type { GamePhase, MatchEvent, OddsInputs, ScoreState } from '@calledit/market-engine';
import { TXLINE_TUNABLES } from './constants.js';
import { sleep, type EventSourceEndReason, type MatchEventSource } from './event-source.js';
import { consoleLogger, type TxlineLogger } from './logging.js';
import {
  buildOddsSuspensionEvent,
  classifyOddsRecord,
  combineOddsSnapshot,
  isFullMatchPeriod,
  isOddsSuspended,
} from './normalize-odds.js';
import { normalizeScores } from './normalize-scores.js';
import type { OddsRecord, ScoresRecord } from './schemas.js';

/** The subset of TxlineClient ReplaySource needs — kept narrow for tests. */
export interface ReplaySnapshotClient {
  scoresSnapshot(fixtureId: number, asOfMs?: number): Promise<ScoresRecord[]>;
  oddsSnapshot(fixtureId: number, asOfMs?: number): Promise<OddsRecord[]>;
}

export interface ReplaySourceOptions {
  client: ReplaySnapshotClient;
  fixtureId: number;
  /** Virtual-time acceleration: 30 ⇒ one real second replays 30 virtual seconds. */
  speed: number;
  /**
   * Virtual clock origin (Unix ms). When omitted, the fixture's startTime is
   * probed from the live scores snapshot and the clock starts
   * REPLAY_PRE_KICKOFF_LEAD_MS earlier so pre-match records replay too.
   */
  startMs?: number;
  /** Virtual time advanced per tick. */
  tickVirtualMs?: number;
  /** Hard stop if no terminal phase is ever reached. */
  maxVirtualMs?: number;
  preKickoffLeadMs?: number;
  /** Latest usable odds at the virtual time, for pricing. */
  onOddsInputs?: (fixtureId: number, inputs: OddsInputs) => void;
  logger?: TxlineLogger;
}

/**
 * Phases at which a replay has nothing more to emit. Union of the domain's
 * terminal and void phases, kept local so replay logic stays runtime-
 * independent of @calledit/market-engine (types are imported type-only).
 */
const REPLAY_END_PHASES: ReadonlySet<GamePhase> = new Set([
  'F',
  'FET',
  'FPE',
  'ABD',
  'CAN',
  'POST',
  'COV_LOST',
]);

export interface ReplayStepResult {
  events: MatchEvent[];
  virtualNowMs: number;
  done: boolean;
  terminalReached: boolean;
}

/**
 * Replay ingestion: a virtual clock steps through point-in-time `asOf`
 * snapshots (scores + odds) and diffs successive snapshots into the same
 * normalized MatchEvents the live pipeline sees. Always re-fetches with the
 * runner's own credentials — no recorded payloads.
 */
export class ReplaySource implements MatchEventSource {
  private readonly client: ReplaySnapshotClient;
  private readonly fixtureId: number;
  private readonly speed: number;
  private readonly tickVirtualMs: number;
  private readonly maxVirtualMs: number;
  private readonly preKickoffLeadMs: number;
  private readonly explicitStartMs: number | undefined;
  private readonly onOddsInputs: ReplaySourceOptions['onOddsInputs'];
  private readonly logger: TxlineLogger;

  private started = false;
  private stopped = false;
  private readonly lifecycle = new AbortController();

  private virtualStartMs: number | null = null;
  private virtualNowMs: number | null = null;
  private readonly seenSeqs = new Set<number>();
  private lastOddsPinMessageId: string | null = null;
  private oddsSuspended = false;

  /** Shared normalization state (see NormalizeScoresOptions docs). */
  private readonly seqByEventId = new Map<number, number>();
  private readonly lastPhaseByFixture = new Map<number, GamePhase>();
  private readonly lastScoreByFixture = new Map<number, ScoreState>();

  constructor(options: ReplaySourceOptions) {
    if (options.speed <= 0) throw new Error('ReplaySource speed must be > 0');
    this.client = options.client;
    this.fixtureId = options.fixtureId;
    this.speed = options.speed;
    this.tickVirtualMs = options.tickVirtualMs ?? TXLINE_TUNABLES.REPLAY_TICK_VIRTUAL_MS;
    this.maxVirtualMs = options.maxVirtualMs ?? TXLINE_TUNABLES.REPLAY_MAX_VIRTUAL_MS;
    this.preKickoffLeadMs = options.preKickoffLeadMs ?? TXLINE_TUNABLES.REPLAY_PRE_KICKOFF_LEAD_MS;
    this.explicitStartMs = options.startMs;
    this.onOddsInputs = options.onOddsInputs;
    this.logger = options.logger ?? consoleLogger;
  }

  start(
    onEvent: (event: MatchEvent) => Promise<void>,
    onEnd?: (reason: EventSourceEndReason) => void,
  ): void {
    if (this.started) throw new Error('ReplaySource.start() called twice');
    this.started = true;
    void (async () => {
      let reason: EventSourceEndReason;
      try {
        reason = await this.run(onEvent);
      } catch (error) {
        this.logger('replay loop crashed', { fixtureId: this.fixtureId, error: String(error) });
        reason = 'failed';
      }
      try {
        onEnd?.(reason);
      } catch (error) {
        this.logger('replay end callback failed', {
          fixtureId: this.fixtureId,
          error: String(error),
        });
      }
    })();
  }

  stop(): void {
    this.stopped = true;
    this.lifecycle.abort();
  }

  /**
   * The virtual clock's current position (unix ms), or null before the first
   * tick. Lets the engine price a market minted mid-replay from the same
   * point-in-time `asOf` odds the replay is emitting events for — instead of
   * the (empty, post-match) live snapshot.
   */
  currentAsOfMs(): number | null {
    return this.virtualNowMs;
  }

  /**
   * Advances the virtual clock one tick and returns the newly-visible events.
   * Exposed so the engine (and tests) can drive replay deterministically.
   */
  async stepOnce(): Promise<ReplayStepResult> {
    const virtualStartMs = this.virtualStartMs ?? (await this.resolveVirtualStart());
    this.virtualStartMs = virtualStartMs;
    const virtualNowMs =
      this.virtualNowMs === null ? virtualStartMs : this.virtualNowMs + this.tickVirtualMs;
    const receivedAtMs = Date.now();
    const events: MatchEvent[] = [];

    // Scores: emit every record whose seq we have not replayed yet.
    // Treat the score/odds snapshot as one replay tick. A throttled odds call
    // must not consume score records that were never delivered to the engine.
    const [scoreRecords, oddsRecords] = await Promise.all([
      this.client.scoresSnapshot(this.fixtureId, virtualNowMs),
      this.client.oddsSnapshot(this.fixtureId, virtualNowMs),
    ]);
    const freshRecords = scoreRecords.filter((record) => !this.seenSeqs.has(record.seq));
    const seenAfterTick = new Set(this.seenSeqs);
    for (const record of freshRecords) seenAfterTick.add(record.seq);
    events.push(
      ...normalizeScores(freshRecords, receivedAtMs, {
        seqByEventId: this.seqByEventId,
        lastPhaseByFixture: this.lastPhaseByFixture,
        lastScoreByFixture: this.lastScoreByFixture,
        logger: this.logger,
      }),
    );

    // Odds: surface suspensions as MatchEvents and price changes via the hook.
    const trackedOdds = oddsRecords.filter(
      (record) =>
        classifyOddsRecord(record, this.logger) !== null &&
        // Half-time market suspensions must not freeze full-match markets.
        isFullMatchPeriod(record.MarketPeriod, this.logger),
    );
    const suspendedNow = trackedOdds.some((record) => isOddsSuspended(record));
    const firstSuspended = trackedOdds.find((record) => isOddsSuspended(record));
    if (suspendedNow && !this.oddsSuspended && firstSuspended !== undefined) {
      events.push(
        buildOddsSuspensionEvent(firstSuspended, receivedAtMs, {
          phase: this.lastPhaseByFixture.get(this.fixtureId),
          score: this.lastScoreByFixture.get(this.fixtureId),
        }),
      );
    }
    this.oddsSuspended = suspendedNow;

    const inputs = combineOddsSnapshot(trackedOdds, { logger: this.logger });
    if (
      inputs !== null &&
      inputs.oddsMessageId !== null &&
      inputs.oddsMessageId !== this.lastOddsPinMessageId
    ) {
      this.lastOddsPinMessageId = inputs.oddsMessageId;
      this.onOddsInputs?.(this.fixtureId, inputs);
    }

    let reachedEndPhase = events.some((event) => REPLAY_END_PHASES.has(event.phase));
    if (reachedEndPhase) {
      // A terminal phase is not necessarily the provider's final record. Drain
      // the canonical latest snapshot once so post-whistle score/stat
      // corrections are processed before replay settlement is considered
      // complete and oracle signers see the same terminal evidence root.
      const finalRecords = await this.client.scoresSnapshot(this.fixtureId);
      const trailingRecords = finalRecords.filter((record) => !seenAfterTick.has(record.seq));
      for (const record of trailingRecords) seenAfterTick.add(record.seq);
      events.push(
        ...normalizeScores(trailingRecords, receivedAtMs, {
          seqByEventId: this.seqByEventId,
          lastPhaseByFixture: this.lastPhaseByFixture,
          lastScoreByFixture: this.lastScoreByFixture,
          logger: this.logger,
        }),
      );
      reachedEndPhase = events.some((event) => REPLAY_END_PHASES.has(event.phase));
    }
    const exhaustedClock = virtualNowMs - virtualStartMs >= this.maxVirtualMs;
    if (exhaustedClock && !reachedEndPhase) {
      this.logger('replay hit max virtual duration without a terminal phase', {
        fixtureId: this.fixtureId,
        maxVirtualMs: this.maxVirtualMs,
      });
    }
    this.seenSeqs.clear();
    for (const seq of seenAfterTick) this.seenSeqs.add(seq);
    // Commit the virtual clock only after the complete score + odds tick has
    // succeeded. A throttled provider call must be retried at the same asOf
    // boundary or replay pricing/cutoffs become dependent on network failures.
    this.virtualNowMs = virtualNowMs;
    return {
      events,
      virtualNowMs,
      done: reachedEndPhase || exhaustedClock,
      terminalReached: reachedEndPhase,
    };
  }

  private async run(
    onEvent: (event: MatchEvent) => Promise<void>,
  ): Promise<EventSourceEndReason> {
    const tickWallMs = this.tickVirtualMs / this.speed;
    let nextTickAtMs = Date.now();
    while (!this.stopped) {
      let step: ReplayStepResult;
      try {
        step = await this.stepOnce();
      } catch (error) {
        if (this.stopped) return 'stopped';
        if (this.virtualStartMs === null) {
          // Could not even resolve the clock origin — nothing to replay.
          this.logger('replay could not start', { fixtureId: this.fixtureId, error: String(error) });
          return 'failed';
        }
        this.logger('replay tick failed — continuing', {
          fixtureId: this.fixtureId,
          error: String(error),
        });
        if (
          this.virtualNowMs !== null &&
          this.virtualStartMs !== null &&
          this.virtualNowMs - this.virtualStartMs >= this.maxVirtualMs
        ) {
          return 'failed';
        }
        // Retry the same virtual boundary after one full frame. Provider
        // failures do not advance the replay clock or trigger a catch-up burst.
        nextTickAtMs = Date.now() + tickWallMs;
        await sleep(tickWallMs, this.lifecycle.signal);
        continue;
      }
      for (const event of step.events) {
        if (this.stopped) return 'stopped';
        await onEvent(event);
      }
      if (step.done) return step.terminalReached ? 'completed' : 'failed';
      // Pace against an absolute deadline so snapshot/event processing is
      // part of the frame instead of being added on top of it. When a frame
      // overruns, preserve every virtual tick and catch up without sleeping.
      nextTickAtMs += tickWallMs;
      await sleep(Math.max(0, nextTickAtMs - Date.now()), this.lifecycle.signal);
    }
    return 'stopped';
  }

  private async resolveVirtualStart(): Promise<number> {
    if (this.explicitStartMs !== undefined) return this.explicitStartMs;
    const records = await this.client.scoresSnapshot(this.fixtureId);
    const startTime = records.find((record) => record.startTime !== undefined)?.startTime;
    if (startTime === undefined) {
      throw new Error(
        `ReplaySource: cannot resolve kickoff for fixture ${this.fixtureId} — ` +
          'no scores records with startTime; pass startMs explicitly',
      );
    }
    return startTime - this.preKickoffLeadMs;
  }
}
