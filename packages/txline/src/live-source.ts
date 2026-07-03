import type { GamePhase, MatchEvent, OddsInputs, ScoreState } from '@calledit/market-engine';
import type { OpenStreamOptions, StreamKind, TxlineClient } from './client.js';
import { TXLINE_TUNABLES } from './constants.js';
import { sleep, type CursorStore, type MatchEventSource } from './event-source.js';
import { consoleLogger, type TxlineLogger } from './logging.js';
import {
  buildOddsSuspensionEvent,
  classifyOddsRecord,
  isFullMatchPeriod,
  isOddsSuspended,
  normalizeOdds,
} from './normalize-odds.js';
import { normalizeScores } from './normalize-scores.js';
import { oddsRecordSchema } from './schemas.js';
import { parseSseStream } from './sse.js';

/** The subset of TxlineClient LiveSource needs — kept narrow for tests. */
export interface LiveStreamClient {
  openStream(kind: StreamKind, options?: OpenStreamOptions): Promise<Response>;
}

export interface LiveSourceOptions {
  client: LiveStreamClient | TxlineClient;
  cursorStore: CursorStore;
  /** Optional single-fixture filter passed to the SSE endpoints. */
  fixtureId?: number;
  /** Which streams to consume; defaults to both scores and odds. */
  streams?: readonly StreamKind[];
  heartbeatTimeoutMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  /**
   * Called after every successful RE-connect (not the first connect) with the
   * cursor the stream resumed from — apps/engine snapshot-fills any gap the
   * resume might have missed.
   */
  gapFill?: (stream: StreamKind, lastEventId: string | null) => Promise<void>;
  /** Latest usable odds per fixture, for pricing. Not a MatchEvent. */
  onOddsInputs?: (fixtureId: number, inputs: OddsInputs) => void;
  logger?: TxlineLogger;
}

const BACKOFF_FACTOR = 2;

/**
 * Live SSE ingestion: consumes /api/scores/stream and /api/odds/stream over
 * fetch ReadableStreams, persists Last-Event-ID after each processed frame,
 * reconnects with exponential backoff on error/heartbeat-silence, and resumes
 * from the stored cursor (plus a snapshot gap-fill hook on reconnect).
 */
export class LiveSource implements MatchEventSource {
  private readonly client: LiveStreamClient;
  private readonly cursorStore: CursorStore;
  private readonly fixtureId: number | undefined;
  private readonly streams: readonly StreamKind[];
  private readonly heartbeatTimeoutMs: number;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly gapFill: LiveSourceOptions['gapFill'];
  private readonly onOddsInputs: LiveSourceOptions['onOddsInputs'];
  private readonly logger: TxlineLogger;

  private started = false;
  private stopped = false;
  /** Aborted on stop() so in-flight reads and backoff sleeps end promptly. */
  private readonly lifecycle = new AbortController();
  private readonly streamControllers = new Map<StreamKind, AbortController>();
  private readonly watchdogs = new Map<StreamKind, ReturnType<typeof setTimeout>>();

  /** Shared normalization state (see NormalizeScoresOptions docs). */
  private readonly seqByEventId = new Map<number, number>();
  private readonly lastPhaseByFixture = new Map<number, GamePhase>();
  private readonly lastScoreByFixture = new Map<number, ScoreState>();
  private readonly oddsSuspendedByFixture = new Map<number, boolean>();

  constructor(options: LiveSourceOptions) {
    this.client = options.client;
    this.cursorStore = options.cursorStore;
    this.fixtureId = options.fixtureId;
    this.streams = options.streams ?? ['scores', 'odds'];
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? TXLINE_TUNABLES.HEARTBEAT_TIMEOUT_MS;
    this.reconnectBaseDelayMs =
      options.reconnectBaseDelayMs ?? TXLINE_TUNABLES.RECONNECT_BASE_DELAY_MS;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? TXLINE_TUNABLES.RECONNECT_MAX_DELAY_MS;
    this.gapFill = options.gapFill;
    this.onOddsInputs = options.onOddsInputs;
    this.logger = options.logger ?? consoleLogger;
  }

  start(onEvent: (event: MatchEvent) => Promise<void>): void {
    if (this.started) throw new Error('LiveSource.start() called twice');
    this.started = true;
    for (const kind of this.streams) {
      void this.runStream(kind, onEvent).catch((error) => {
        this.logger('stream loop crashed', { kind, error: String(error) });
      });
    }
  }

  stop(): void {
    this.stopped = true;
    this.lifecycle.abort();
    for (const controller of this.streamControllers.values()) controller.abort();
    for (const watchdog of this.watchdogs.values()) clearTimeout(watchdog);
    this.watchdogs.clear();
  }

  cursorName(kind: StreamKind): string {
    return `txline:${kind}:${this.fixtureId ?? 'all'}`;
  }

  private async runStream(
    kind: StreamKind,
    onEvent: (event: MatchEvent) => Promise<void>,
  ): Promise<void> {
    let consecutiveFailures = 0;
    let connectedBefore = false;

    while (!this.stopped) {
      const cursorName = this.cursorName(kind);
      const lastEventId = await this.cursorStore.get(cursorName);
      const controller = new AbortController();
      this.streamControllers.set(kind, controller);

      try {
        const res = await this.client.openStream(kind, {
          fixtureId: this.fixtureId,
          lastEventId,
          signal: controller.signal,
        });
        consecutiveFailures = 0;
        if (connectedBefore && this.gapFill !== undefined) {
          await this.gapFill(kind, lastEventId);
        }
        connectedBefore = true;

        this.armWatchdog(kind, controller);
        if (res.body === null) throw new Error('stream response has no body');
        for await (const frame of parseSseStream(res.body)) {
          this.armWatchdog(kind, controller);
          if (frame.event !== 'heartbeat' && frame.data !== '') {
            await this.handleData(kind, frame.data, onEvent);
          }
          if (frame.id !== null && frame.id !== '') {
            await this.cursorStore.set(cursorName, frame.id);
          }
        }
        // Server closed the stream cleanly — fall through and reconnect.
      } catch (error) {
        if (!this.stopped) {
          this.logger('stream error — will reconnect', { kind, error: String(error) });
        }
      } finally {
        this.disarmWatchdog(kind);
      }

      if (this.stopped) break;
      consecutiveFailures += 1;
      const delay = Math.min(
        this.reconnectBaseDelayMs * BACKOFF_FACTOR ** (consecutiveFailures - 1),
        this.reconnectMaxDelayMs,
      );
      await sleep(delay, this.lifecycle.signal);
    }
  }

  private async handleData(
    kind: StreamKind,
    data: string,
    onEvent: (event: MatchEvent) => Promise<void>,
  ): Promise<void> {
    let record: unknown;
    try {
      record = JSON.parse(data);
    } catch {
      this.logger('stream frame is not valid JSON', { kind, excerpt: data.slice(0, 120) });
      return;
    }

    if (kind === 'scores') {
      const events = normalizeScores(record, Date.now(), {
        seqByEventId: this.seqByEventId,
        lastPhaseByFixture: this.lastPhaseByFixture,
        lastScoreByFixture: this.lastScoreByFixture,
        logger: this.logger,
      });
      for (const event of events) {
        if (this.stopped) return;
        await onEvent(event);
      }
      return;
    }

    await this.handleOddsRecord(record, onEvent);
  }

  private async handleOddsRecord(
    record: unknown,
    onEvent: (event: MatchEvent) => Promise<void>,
  ): Promise<void> {
    const parsed = oddsRecordSchema.safeParse(record);
    if (!parsed.success) {
      this.logger('skipping unparseable odds record', {
        issues: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`),
      });
      return;
    }
    const odds = parsed.data;
    // classifyOddsRecord logs unknown SuperOddsType strings exactly once here.
    if (classifyOddsRecord(odds, this.logger) === null) return;
    // Half-time market suspensions must not freeze full-match markets.
    if (!isFullMatchPeriod(odds.MarketPeriod, this.logger)) return;

    const wasSuspended = this.oddsSuspendedByFixture.get(odds.FixtureId) ?? false;
    const suspendedNow = isOddsSuspended(odds);
    this.oddsSuspendedByFixture.set(odds.FixtureId, suspendedNow);

    if (suspendedNow) {
      if (!wasSuspended && !this.stopped) {
        await onEvent(
          buildOddsSuspensionEvent(odds, Date.now(), {
            phase: this.lastPhaseByFixture.get(odds.FixtureId),
            score: this.lastScoreByFixture.get(odds.FixtureId),
          }),
        );
      }
      return;
    }

    const inputs = normalizeOdds(odds, { logger: this.logger });
    if (inputs !== null && this.onOddsInputs !== undefined) {
      this.onOddsInputs(odds.FixtureId, inputs);
    }
  }

  private armWatchdog(kind: StreamKind, controller: AbortController): void {
    this.disarmWatchdog(kind);
    const watchdog = setTimeout(() => {
      this.logger('heartbeat timeout — reconnecting', {
        kind,
        timeoutMs: this.heartbeatTimeoutMs,
      });
      controller.abort();
    }, this.heartbeatTimeoutMs);
    this.watchdogs.set(kind, watchdog);
  }

  private disarmWatchdog(kind: StreamKind): void {
    const watchdog = this.watchdogs.get(kind);
    if (watchdog !== undefined) clearTimeout(watchdog);
    this.watchdogs.delete(kind);
  }
}
