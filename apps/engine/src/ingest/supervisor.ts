/**
 * Ingest supervisor: one MatchEventSource per live fixture (LiveSource), or a
 * ReplaySource when a group replay is active. Every normalized event funnels
 * into the settler (insertFeedEvent dedupes, then reduce + effects).
 */

import { TERMINAL_PHASES, type MatchEvent } from '@calledit/market-engine';
import type { Deps, EventSourceLike } from '../ports.js';
import { ENGINE } from '../engineConstants.js';
import type { Settler } from '../settle/settler.js';

interface ActiveReplay {
  fixtureId: number;
  source: EventSourceLike;
}

export class IngestSupervisor {
  private readonly liveSources = new Map<number, EventSourceLike>();
  private readonly replays = new Map<number, ActiveReplay>();
  /** Called when a replay's fixture reaches a terminal phase. */
  onReplayFinished: ((groupId: number, fixtureId: number) => void) | null = null;

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
    } catch (err) {
      this.deps.log.warn('ingest_refresh_failed', { error: String(err) });
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

  startReplay(groupId: number, fixtureId: number, speed: number = ENGINE.REPLAY_SPEED): void {
    const source = this.deps.tx.createReplaySource(fixtureId, speed);
    this.replays.set(groupId, { fixtureId, source });
    this.deps.log.info('replay_started', { groupId, fixtureId, speed });
    source.start(async (event) => {
      await this.handleEvent(event);
      if (event.kind === 'phase_change' && TERMINAL_PHASES.includes(event.phase)) {
        this.stopReplay(groupId);
        this.onReplayFinished?.(groupId, fixtureId);
      }
    });
  }

  stopReplay(groupId: number): boolean {
    const replay = this.replays.get(groupId);
    if (!replay) return false;
    replay.source.stop();
    this.replays.delete(groupId);
    this.deps.log.info('replay_stopped', { groupId, fixtureId: replay.fixtureId });
    return true;
  }

  /** Fixture currently replaying for a group, or null. */
  replayFixture(groupId: number): number | null {
    return this.replays.get(groupId)?.fixtureId ?? null;
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
    } catch (err) {
      this.deps.log.error('live_source_start_failed', { fixtureId, error: String(err) });
    }
  }

  private async handleEvent(event: MatchEvent): Promise<void> {
    try {
      await this.settler.onEvent(event);
    } catch (err) {
      this.deps.log.error('event_handling_failed', {
        fixtureId: event.fixtureId,
        seq: event.seq,
        error: String(err),
      });
    }
  }
}
