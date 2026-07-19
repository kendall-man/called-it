/**
 * Ingest supervisor: one MatchEventSource per live fixture (LiveSource), or a
 * ReplaySource when a group replay is active. Every normalized event funnels
 * into the settler (insertFeedEvent dedupes, then reduce + effects).
 */

import type { MatchEvent } from '@calledit/market-engine';
import type { Deps, EventSourceLike, FixtureRow, MarketRow } from '../ports.js';
import { ENGINE } from '../engineConstants.js';
import type { Settler } from '../settle/settler.js';

interface ActiveReplay {
  runId: number;
  fixtureId: number;
  source: EventSourceLike;
  speed: number;
  fixture: FixtureRow;
  runStartedAtMs: number;
  virtualStartedAtMs: number;
  virtualNowMs: number;
  lastEventVirtualMs: number | null;
  firstEventTsMs: number | null;
  wallStartedAtMs: number;
  lastLagWarningAtMs: number | null;
  processingLagging: boolean;
  startDelayTimer: ReturnType<typeof setTimeout> | null;
  ending: boolean;
}

export interface ReplayRunIdentity {
  readonly groupId: number;
  readonly fixtureId: number;
  readonly runId: number;
  /** Persisted replay markets must have been created at or after this boundary. */
  readonly startedAtMs: number;
}

export type ReplayPositionAdmission =
  | { readonly kind: 'allowed'; readonly run: ReplayRunIdentity }
  | { readonly kind: 'not_replay' }
  | { readonly kind: 'stale'; readonly reason: 'no_active_run' | 'fixture_mismatch' | 'prior_run' };

/**
 * Parent wiring must persist this request before it reports a replay complete.
 * A source reaching EOF is only evidence that confirmation should be attempted.
 */
export interface ReplayConfirmationScheduler {
  scheduleReplayConfirmation(input: ReplayRunIdentity & {
    readonly sourceCompletedAtMs: number;
  }): Promise<void>;
}

const REPLAY_PRE_KICKOFF_MS = 10 * 60_000;
const REPLAY_PROCESSING_LAG_WARNING_MS = 60_000;
const REPLAY_PROCESSING_LAG_LOG_INTERVAL_MS = 60_000;
const ACTIVE_PHASE_MINUTE_CEILING: Partial<Record<FixtureRow['phase'], number>> = {
  H1: 45,
  H2: 90,
  ET1: 105,
  ET2: 120,
};

export type ReplayStartResult = 'started' | 'already_active' | 'live_markets';

export class IngestSupervisor {
  private readonly liveSources = new Map<number, EventSourceLike>();
  private readonly replays = new Map<number, ActiveReplay>();
  private readonly groupLocks = new Map<number, Promise<void>>();
  private nextReplayRunId = 1;
  /**
   * Deprecated: source completion is not terminal settlement. Parent wiring
   * must report user-facing completion from the durable confirmation path.
   */
  onReplayFinished: ((groupId: number, fixtureId: number) => void) | null = null;
  /** Called when the replay source or its strict settlement path fails. */
  onReplayFailed: ((groupId: number, fixtureId: number) => void) | null = null;
  /** Called only after a durable replay-confirmation request has been scheduled. */
  onReplayConfirmationScheduled: ((input: ReplayRunIdentity) => void) | null = null;

  constructor(
    private readonly deps: Deps,
    private readonly settler: Settler,
    private readonly replayConfirmation: ReplayConfirmationScheduler | null = null,
  ) {}

  /** Reconcile running live sources against the fixtures table. */
  async refresh(): Promise<void> {
    let wanted: number[];
    try {
      const fixtures = await this.deps.db.liveFixtures(this.deps.now(), ENGINE.LIVE_LOOKAHEAD_MS);
      wanted = fixtures.map((f) => f.fixture_id);
    } catch {
      this.deps.log.warn('ingest_refresh_failed');
      return;
    }
    for (const fixtureId of wanted) {
      if (!this.liveSources.has(fixtureId)) this.startLive(fixtureId);
    }
    for (const [fixtureId, source] of [...this.liveSources]) {
      if (!wanted.includes(fixtureId)) {
        source.stop();
        this.liveSources.delete(fixtureId);
        this.deps.log.info('live_source_stopped', { fixtureId });
      }
    }
  }

  hasActiveReplay(groupId: number): boolean {
    return this.replays.has(groupId);
  }

  async startReplay(
    groupId: number,
    fixture: FixtureRow,
    speed: number = ENGINE.REPLAY_SPEED,
    startDelayMs: number = 0,
  ): Promise<ReplayStartResult> {
    return this.runGroupExclusive(groupId, async () => {
      if (this.replays.has(groupId)) return 'already_active';
      const openMarkets = await this.deps.db.openMarketsForGroup(groupId);
      if (openMarkets.some((market) => !market.is_replay)) return 'live_markets';
      await this.lockReplayMarkets(openMarkets);

      const fixtureId = fixture.fixture_id;
      const source = this.deps.tx.createReplaySource(fixtureId, speed);
      const kickoffMs = fixture.kickoff_at === null ? NaN : Date.parse(fixture.kickoff_at);
      if (!Number.isFinite(kickoffMs)) throw new Error('Replay fixture kickoff is unavailable');
      const replay: ActiveReplay = {
        runId: this.nextReplayRunId++,
        fixtureId,
        source,
        speed,
        fixture: {
          ...fixture,
          phase: 'NS',
          minute: null,
          last_seq: 0,
          score: {},
        },
        runStartedAtMs: this.deps.now(),
        virtualStartedAtMs: kickoffMs - REPLAY_PRE_KICKOFF_MS,
        virtualNowMs: kickoffMs - REPLAY_PRE_KICKOFF_MS,
        lastEventVirtualMs: null,
        firstEventTsMs: null,
        wallStartedAtMs: this.deps.now(),
        lastLagWarningAtMs: null,
        processingLagging: false,
        startDelayTimer: null,
        ending: false,
      };
      this.replays.set(groupId, replay);
      this.deps.log.info('replay_started', { fixtureId, speed });
      const startSource = () => {
        source.start(
          (event) => this.runGroupExclusive(groupId, async () => {
            const active = this.replays.get(groupId);
            if (active !== replay || active.ending) return;
            const virtualNowMs = this.syncVirtualNow(active, event.tsMs);
            active.lastEventVirtualMs = virtualNowMs;
            active.fixture = {
              ...active.fixture,
              phase: event.phase,
              minute: event.minute,
              last_seq: event.seq,
              score: event.score as unknown as FixtureRow['score'],
            };
            try {
              await this.settler.onReplayEvent(
                groupId,
                this.toReplayEvent(active, event),
                active.runStartedAtMs,
              );
              this.recordReplayProcessingLag(active);
            } catch (error) {
              active.ending = true;
              throw error;
            }
          }),
          (reason) => {
            void this.finishReplay(groupId, replay, reason);
          },
        );
      };
      try {
        if (startDelayMs <= 0) {
          startSource();
        } else {
          replay.startDelayTimer = setTimeout(() => {
            replay.startDelayTimer = null;
            if (this.replays.get(groupId) !== replay || replay.ending) return;
            try {
              replay.wallStartedAtMs = this.deps.now();
              startSource();
            } catch {
              void this.finishReplay(groupId, replay, 'failed');
            }
          }, startDelayMs);
        }
      } catch (error) {
        this.replays.delete(groupId);
        source.stop();
        throw error;
      }
      return 'started';
    });
  }

  stopReplay(groupId: number): boolean {
    const replay = this.replays.get(groupId);
    if (!replay) return false;
    replay.ending = true;
    if (replay.startDelayTimer !== null) clearTimeout(replay.startDelayTimer);
    replay.source.stop();
    this.replays.delete(groupId);
    void this.runGroupExclusive(groupId, async () => {
      await this.lockReplayMarkets(await this.deps.db.openMarketsForGroup(groupId));
      this.deps.log.info('replay_stopped', { fixtureId: replay.fixtureId });
    }).catch(() => {
      this.deps.log.error('replay_stop_lock_failed', { fixtureId: replay.fixtureId });
    });
    return true;
  }

  /** Fixture currently replaying for a group, or null. */
  replayFixture(groupId: number): number | null {
    const replay = this.replays.get(groupId);
    return replay === undefined || replay.ending ? null : replay.fixtureId;
  }

  replayRunId(groupId: number): number | null {
    const replay = this.replays.get(groupId);
    return replay === undefined || replay.ending ? null : replay.runId;
  }

  replayRun(groupId: number): ReplayRunIdentity | null {
    const replay = this.replays.get(groupId);
    if (replay === undefined || replay.ending) return null;
    return {
      groupId,
      fixtureId: replay.fixtureId,
      runId: replay.runId,
      startedAtMs: replay.runStartedAtMs,
    };
  }

  /**
   * Callback handlers must call this before accepting a replay position. It
   * fails closed after a restart and freezes the stale persisted market.
   */
  async admitReplayPosition(market: Pick<
    MarketRow,
    'id' | 'group_id' | 'fixture_id' | 'is_replay' | 'created_at'
  >): Promise<ReplayPositionAdmission> {
    if (!market.is_replay) return { kind: 'not_replay' };
    const run = this.replayRun(market.group_id);
    const createdAtMs = Date.parse(market.created_at);
    const reason = run === null
      ? 'no_active_run'
      : run.fixtureId !== market.fixture_id
        ? 'fixture_mismatch'
        : !Number.isFinite(createdAtMs) || createdAtMs < run.startedAtMs
          ? 'prior_run'
          : null;
    if (reason === null) {
      if (run === null) throw new TypeError('active replay admission is inconsistent');
      return { kind: 'allowed', run };
    }
    await this.deps.db.updateMarketStatus(market.id, 'frozen');
    this.deps.log.info('replay_stale_market_locked', { marketId: market.id, reason });
    return { kind: 'stale', reason };
  }

  /** Lock all open replay markets for a group after an unclean restart. */
  async recoverReplayGroup(groupId: number): Promise<number> {
    return this.lockReplayMarkets(await this.deps.db.openMarketsForGroup(groupId));
  }

  /** Group-scoped virtual fixture state. The durable fixture row is never regressed. */
  replaySnapshot(groupId: number): FixtureRow | null {
    const replay = this.replays.get(groupId);
    if (replay === undefined || replay.ending) return null;
    const virtualNowMs = this.syncVirtualNow(replay);
    return {
      ...replay.fixture,
      minute: this.projectMinute(replay, virtualNowMs),
      score: { ...replay.fixture.score },
    };
  }

  replayAsOfForGroup(groupId: number): number | null {
    const replay = this.replays.get(groupId);
    return replay === undefined || replay.ending ? null : this.syncVirtualNow(replay);
  }

  /**
   * Virtual clock (unix ms) of any active replay for this fixture, or null.
   * Lets odds pricing pin the replay's point-in-time snapshot instead of the
   * empty post-match live book.
   */
  replayAsOf(fixtureId: number): number | null {
    for (const replay of this.replays.values()) {
      if (!replay.ending && replay.fixtureId === fixtureId) {
        return this.syncVirtualNow(replay);
      }
    }
    return null;
  }

  stopAll(): void {
    for (const source of this.liveSources.values()) source.stop();
    this.liveSources.clear();
    for (const groupId of [...this.replays.keys()]) this.stopReplay(groupId);
  }

  private startLive(fixtureId: number): void {
    try {
      const source = this.deps.tx.createLiveSource(fixtureId);
      this.liveSources.set(fixtureId, source);
      this.deps.log.info('live_source_started', { fixtureId });
      source.start(async (event) => {
        await this.handleEvent(event);
      });
    } catch {
      this.deps.log.error('live_source_start_failed', { fixtureId });
    }
  }

  private async handleEvent(event: MatchEvent): Promise<void> {
    try {
      await this.settler.onEvent(event);
    } catch {
      this.deps.log.error('event_handling_failed', {
        fixtureId: event.fixtureId,
        seq: event.seq,
      });
    }
  }

  /** Serialize replay transitions, event settlement, and market minting per group. */
  async runGroupExclusive<T>(groupId: number, task: () => Promise<T>): Promise<T> {
    const previous = this.groupLocks.get(groupId) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.groupLocks.set(groupId, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.groupLocks.get(groupId) === tail) this.groupLocks.delete(groupId);
    }
  }

  private async finishReplay(
    groupId: number,
    replay: ActiveReplay,
    reason: 'completed' | 'failed' | 'stopped',
  ): Promise<void> {
    await this.runGroupExclusive(groupId, async () => {
      if (this.replays.get(groupId) !== replay) return;
      replay.ending = true;
      if (replay.startDelayTimer !== null) clearTimeout(replay.startDelayTimer);
      replay.source.stop();
      this.replays.delete(groupId);
      await this.lockReplayMarkets(await this.deps.db.openMarketsForGroup(groupId));
      if (reason === 'completed') {
        const confirmation = {
          groupId,
          fixtureId: replay.fixtureId,
          runId: replay.runId,
          startedAtMs: replay.runStartedAtMs,
          sourceCompletedAtMs: this.deps.now(),
        };
        if (this.replayConfirmation === null) {
          this.deps.log.warn('replay_confirmation_scheduler_unwired', { fixtureId: replay.fixtureId });
          return;
        }
        await this.replayConfirmation.scheduleReplayConfirmation(confirmation);
        this.deps.log.info('replay_confirmation_scheduled', { fixtureId: replay.fixtureId });
        this.onReplayConfirmationScheduled?.(confirmation);
        return;
      }
      if (reason === 'stopped') {
        this.deps.log.info('replay_stopped', { fixtureId: replay.fixtureId });
        return;
      }
      this.deps.log.error('replay_failed', { fixtureId: replay.fixtureId });
      this.onReplayFailed?.(groupId, replay.fixtureId);
    });
  }

  private async lockReplayMarkets(markets: readonly MarketRow[]): Promise<number> {
    const stale = markets.filter((market) => market.is_replay);
    for (const market of stale) await this.deps.db.updateMarketStatus(market.id, 'frozen');
    return stale.length;
  }

  private syncVirtualNow(replay: ActiveReplay, fallback?: number): number {
    const sourceNow = replay.source.currentAsOfMs?.();
    const next = sourceNow ?? fallback;
    if (next !== undefined && Number.isFinite(next)) {
      replay.virtualNowMs = Math.max(replay.virtualNowMs, next);
    }
    return replay.virtualNowMs;
  }

  private recordReplayProcessingLag(replay: ActiveReplay): void {
    const nowMs = this.deps.now();
    const wallElapsedMs = Math.max(0, nowMs - replay.wallStartedAtMs);
    const virtualElapsedMs = Math.max(0, replay.virtualNowMs - replay.virtualStartedAtMs);
    const expectedWallElapsedMs = virtualElapsedMs / replay.speed;
    const lagMs = Math.max(0, Math.round(wallElapsedMs - expectedWallElapsedMs));
    if (lagMs > REPLAY_PROCESSING_LAG_WARNING_MS) {
      replay.processingLagging = true;
      if (
        replay.lastLagWarningAtMs === null ||
        nowMs - replay.lastLagWarningAtMs >= REPLAY_PROCESSING_LAG_LOG_INTERVAL_MS
      ) {
        replay.lastLagWarningAtMs = nowMs;
        this.deps.log.warn('replay_processing_lag', {
          fixtureId: replay.fixtureId,
          speed: replay.speed,
          lagMs,
        });
      }
      return;
    }
    if (replay.processingLagging) {
      replay.processingLagging = false;
      replay.lastLagWarningAtMs = null;
      this.deps.log.info('replay_processing_lag_recovered', {
        fixtureId: replay.fixtureId,
        speed: replay.speed,
      });
    }
  }

  private projectMinute(replay: ActiveReplay, virtualNowMs: number): number | null {
    const minute = replay.fixture.minute;
    const ceiling = ACTIVE_PHASE_MINUTE_CEILING[replay.fixture.phase];
    if (minute === null || ceiling === undefined || replay.lastEventVirtualMs === null) return minute;
    const elapsed = Math.max(0, Math.floor((virtualNowMs - replay.lastEventVirtualMs) / 60_000));
    return Math.min(ceiling, minute + elapsed);
  }

  /**
   * Historical event timestamps are shifted onto the accelerated wall-clock
   * run so the normal anti-snipe checks can compare them with Telegram taps.
   */
  private toReplayEvent(replay: ActiveReplay, event: MatchEvent): MatchEvent {
    replay.firstEventTsMs ??= event.tsMs;
    return {
      ...event,
      // Preserve provider time for independent oracle evidence verification.
      // The shifted tsMs below remains the replay's anti-snipe/test clock.
      providerTsMs: event.tsMs,
      tsMs:
        replay.wallStartedAtMs +
        Math.round((event.tsMs - replay.firstEventTsMs) / replay.speed),
      receivedAtMs: this.deps.now(),
    } as MatchEvent & { readonly providerTsMs: number };
  }
}
