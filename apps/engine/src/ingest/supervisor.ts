/**
 * Ingest supervisor: one MatchEventSource per live fixture (LiveSource), or a
 * ReplaySource when a group replay is active. Every normalized event funnels
 * into the settler (insertFeedEvent dedupes, then reduce + effects).
 */

import type { MatchEvent } from '@calledit/market-engine';
import type { Deps, EventSourceLike, FixtureRow } from '../ports.js';
import { ENGINE } from '../engineConstants.js';
import type { Settler } from '../settle/settler.js';

interface ActiveReplay {
  runId: number;
  fixtureId: number;
  source: EventSourceLike;
  speed: number;
  fixture: FixtureRow;
  virtualNowMs: number;
  lastEventVirtualMs: number | null;
  firstEventTsMs: number | null;
  wallStartedAtMs: number;
  ending: boolean;
}

const REPLAY_PRE_KICKOFF_MS = 10 * 60_000;
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
  /** Called when a replay's fixture reaches a terminal phase. */
  onReplayFinished: ((groupId: number, fixtureId: number) => void) | null = null;
  /** Called when the replay source or its strict settlement path fails. */
  onReplayFailed: ((groupId: number, fixtureId: number) => void) | null = null;

  constructor(
    private readonly deps: Deps,
    private readonly settler: Settler,
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
  ): Promise<ReplayStartResult> {
    return this.runGroupExclusive(groupId, async () => {
      if (this.replays.has(groupId)) return 'already_active';
      const openMarkets = await this.deps.db.openMarketsForGroup(groupId);
      if (openMarkets.some((market) => !market.is_replay)) return 'live_markets';

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
        virtualNowMs: kickoffMs - REPLAY_PRE_KICKOFF_MS,
        lastEventVirtualMs: null,
        firstEventTsMs: null,
        wallStartedAtMs: this.deps.now(),
        ending: false,
      };
      this.replays.set(groupId, replay);
      this.deps.log.info('replay_started', { fixtureId, speed });
      try {
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
                active.wallStartedAtMs,
              );
            } catch (error) {
              active.ending = true;
              throw error;
            }
          }),
          (reason) => {
            void this.finishReplay(groupId, replay, reason);
          },
        );
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
    replay.source.stop();
    this.replays.delete(groupId);
    this.deps.log.info('replay_stopped', { fixtureId: replay.fixtureId });
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
      replay.source.stop();
      this.replays.delete(groupId);
      if (reason === 'completed') {
        this.deps.log.info('replay_completed', { fixtureId: replay.fixtureId });
        this.onReplayFinished?.(groupId, replay.fixtureId);
        return;
      }
      this.deps.log.error('replay_failed', { fixtureId: replay.fixtureId });
      this.onReplayFailed?.(groupId, replay.fixtureId);
    });
  }

  private syncVirtualNow(replay: ActiveReplay, fallback?: number): number {
    const sourceNow = replay.source.currentAsOfMs?.();
    const next = sourceNow ?? fallback;
    if (next !== undefined && Number.isFinite(next)) {
      replay.virtualNowMs = Math.max(replay.virtualNowMs, next);
    }
    return replay.virtualNowMs;
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
      tsMs:
        replay.wallStartedAtMs +
        Math.round((event.tsMs - replay.firstEventTsMs) / replay.speed),
      receivedAtMs: this.deps.now(),
    };
  }
}
