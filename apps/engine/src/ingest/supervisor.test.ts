import { describe, expect, it, vi } from 'vitest';
import type { MatchEvent } from '@calledit/market-engine';
import { createTelegramFlowRuntime } from '../points/telegram-points-flow-runtime.test-support.js';
import type { FixtureRow } from '../ports.js';
import { IngestSupervisor } from './supervisor.js';

const GROUP_ID = -900_001;
const FIXTURE_ID = 70_001;
const REPLAY_SPEED = 4;
const FIXTURE: FixtureRow = {
  fixture_id: FIXTURE_ID,
  p1_name: 'France',
  p2_name: 'Morocco',
  kickoff_at: '2026-07-09T20:00:00.000Z',
  phase: 'F',
  minute: 90,
  last_seq: 1_113,
  score: { p1: { goals: 2 }, p2: { goals: 0 } },
  coverage_unreliable: false,
};

describe('replay logging privacy', () => {
  it('logs replay start diagnostics without Telegram group identity', async () => {
    // Given an ingest supervisor serving a Telegram group replay
    const runtime = createTelegramFlowRuntime();
    const supervisor = new IngestSupervisor(runtime.deps, runtime.settler);

    // When the replay starts
    await supervisor.startReplay(GROUP_ID, FIXTURE, REPLAY_SPEED);

    // Then only fixture-domain diagnostics are logged
    expect(runtime.log.events.find(({ event }) => event === 'replay_started')?.fields).toEqual({
      fixtureId: FIXTURE_ID,
      speed: REPLAY_SPEED,
    });
  });

  it('logs replay stop diagnostics without Telegram group identity', async () => {
    // Given an active Telegram group replay
    const runtime = createTelegramFlowRuntime();
    const supervisor = new IngestSupervisor(runtime.deps, runtime.settler);
    await supervisor.startReplay(GROUP_ID, FIXTURE, REPLAY_SPEED);

    // When the replay stops
    supervisor.stopReplay(GROUP_ID);

    // Then only the safe fixture ID is logged
    await vi.waitFor(() => {
      expect(runtime.log.events.find(({ event }) => event === 'replay_stopped')?.fields).toEqual({
        fixtureId: FIXTURE_ID,
      });
    });
  });

  it('holds a test replay clock until its setup window has elapsed', async () => {
    vi.useFakeTimers();
    try {
      const runtime = createTelegramFlowRuntime();
      let starts = 0;
      let nowMs = runtime.deps.now();
      let replayBoundary: number | undefined;
      runtime.deps.tx.createReplaySource = () => ({
        start(handler) {
          starts += 1;
          void handler({
            kind: 'phase_change', fixtureId: FIXTURE_ID, seq: 1,
            tsMs: Date.parse(FIXTURE.kickoff_at!), receivedAtMs: nowMs,
            confirmed: true, phase: 'H1', minute: 1,
            score: {
              p1: { goals: 0, yellowCards: 0, redCards: 0, corners: 0 },
              p2: { goals: 0, yellowCards: 0, redCards: 0, corners: 0 },
              p1Goals90: 0, p2Goals90: 0,
            },
          });
        },
        stop() {},
        currentAsOfMs: () => Date.parse(FIXTURE.kickoff_at!) - 10 * 60_000,
      });
      const supervisor = new IngestSupervisor(
        { ...runtime.deps, now: () => nowMs },
        {
          onReplayEvent: async (_groupId: number, _event: MatchEvent, startedAtMs: number) => {
            replayBoundary = startedAtMs;
          },
        } as unknown as typeof runtime.settler,
      );

      await supervisor.startReplay(GROUP_ID, FIXTURE, REPLAY_SPEED, 5 * 60_000);
      const runStartedAtMs = supervisor.replayRun(GROUP_ID)?.startedAtMs;
      expect(starts).toBe(0);
      expect(supervisor.replaySnapshot(GROUP_ID)).toMatchObject({ phase: 'NS', minute: null });

      nowMs += 5 * 60_000;
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(starts).toBe(1);
      expect(supervisor.replayRun(GROUP_ID)?.startedAtMs).toBe(runStartedAtMs);
      expect(replayBoundary).toBe(runStartedAtMs);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps virtual fixture state group-scoped and routes shifted events through replay settlement', async () => {
    // Given a completed durable fixture and a controllable historical source
    const runtime = createTelegramFlowRuntime();
    let emit: ((event: MatchEvent) => Promise<void>) | undefined;
    let stopped = false;
    let virtualNowMs = Date.parse(FIXTURE.kickoff_at!) - 10 * 60_000;
    const replayed: Array<{ groupId: number; event: MatchEvent }> = [];
    runtime.deps.tx.createReplaySource = () => ({
      start(handler) { emit = handler; },
      stop() { stopped = true; },
      currentAsOfMs: () => virtualNowMs,
    });
    const supervisor = new IngestSupervisor(runtime.deps, {
      onReplayEvent: async (groupId: number, event: MatchEvent) => {
        replayed.push({ groupId, event });
      },
    } as unknown as typeof runtime.settler);

    // When replay starts and its first in-play event arrives
    await supervisor.startReplay(GROUP_ID, FIXTURE, REPLAY_SPEED);
    expect(supervisor.replaySnapshot(GROUP_ID)).toMatchObject({ phase: 'NS', last_seq: 0, score: {} });
    virtualNowMs = Date.parse(FIXTURE.kickoff_at!) + 60_000;
    const historicalTs = Date.parse(FIXTURE.kickoff_at!) + 60_000;
    await emit?.({
      kind: 'phase_change',
      fixtureId: FIXTURE_ID,
      seq: 11,
      tsMs: historicalTs,
      receivedAtMs: historicalTs,
      confirmed: true,
      phase: 'H1',
      minute: 1,
      score: {
        p1: { goals: 0, yellowCards: 0, redCards: 0, corners: 0 },
        p2: { goals: 0, yellowCards: 0, redCards: 0, corners: 0 },
        p1Goals90: null,
        p2Goals90: null,
      },
    });

    // Then only virtual state advances and the event uses the accelerated wall clock
    expect(supervisor.replaySnapshot(GROUP_ID)).toMatchObject({ phase: 'H1', minute: 1, last_seq: 11 });
    expect(supervisor.replayAsOfForGroup(GROUP_ID)).toBe(virtualNowMs);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toMatchObject({ groupId: GROUP_ID, event: { fixtureId: FIXTURE_ID, seq: 11 } });
    expect(replayed[0]!.event.tsMs).toBe(runtime.deps.now());
    expect((replayed[0]!.event as MatchEvent & { providerTsMs?: number }).providerTsMs)
      .toBe(historicalTs);
    expect(stopped).toBe(false);
    expect(FIXTURE).toMatchObject({ phase: 'F', last_seq: 1_113 });

    // And the virtual minute continues moving during a quiet score period.
    virtualNowMs += 26 * 60_000;
    expect(supervisor.replaySnapshot(GROUP_ID)?.minute).toBe(27);
  });

  it('schedules durable confirmation only after source success and unlocks failures', async () => {
    const runtime = createTelegramFlowRuntime();
    let emit: ((event: MatchEvent) => Promise<void>) | undefined;
    let end: ((reason: 'completed' | 'failed' | 'stopped') => void) | undefined;
    runtime.deps.tx.createReplaySource = () => ({
      start(handler, onEnd) { emit = handler; end = onEnd; },
      stop() {},
      currentAsOfMs: () => Date.parse(FIXTURE.kickoff_at!) + 90 * 60_000,
    });
    const scheduled: number[] = [];
    const supervisor = new IngestSupervisor(
      runtime.deps,
      { onReplayEvent: async () => undefined } as unknown as typeof runtime.settler,
      {
        scheduleReplayConfirmation: async ({ fixtureId }) => {
          scheduled.push(fixtureId);
        },
      },
    );
    const confirmed: number[] = [];
    const failed: number[] = [];
    supervisor.onReplayConfirmationScheduled = ({ fixtureId }) => { confirmed.push(fixtureId); };
    supervisor.onReplayFailed = (_groupId, fixtureId) => { failed.push(fixtureId); };

    await supervisor.startReplay(GROUP_ID, FIXTURE, REPLAY_SPEED);
    await emit?.({
      ...({
        kind: 'phase_change', fixtureId: FIXTURE_ID, seq: 99,
        tsMs: Date.parse(FIXTURE.kickoff_at!) + 90 * 60_000,
        receivedAtMs: Date.parse(FIXTURE.kickoff_at!) + 90 * 60_000,
        confirmed: true, phase: 'F', minute: 90,
        score: {
          p1: { goals: 2, yellowCards: 0, redCards: 0, corners: 0 },
          p2: { goals: 0, yellowCards: 0, redCards: 0, corners: 0 },
          p1Goals90: 2, p2Goals90: 0,
        },
      } satisfies MatchEvent),
    });
    expect(supervisor.hasActiveReplay(GROUP_ID)).toBe(true);
    expect(scheduled).toEqual([]);
    expect(confirmed).toEqual([]);

    end?.('completed');
    await vi.waitFor(() => expect(supervisor.hasActiveReplay(GROUP_ID)).toBe(false));
    expect(scheduled).toEqual([FIXTURE_ID]);
    expect(confirmed).toEqual([FIXTURE_ID]);

    await supervisor.startReplay(GROUP_ID, FIXTURE, REPLAY_SPEED);
    end?.('failed');
    await vi.waitFor(() => expect(supervisor.hasActiveReplay(GROUP_ID)).toBe(false));
    expect(failed).toEqual([FIXTURE_ID]);
  });

  it('rate-limits replay processing lag warnings and reports recovery', async () => {
    const runtime = createTelegramFlowRuntime();
    let emit: ((event: MatchEvent) => Promise<void>) | undefined;
    let nowMs = runtime.deps.now();
    let virtualNowMs = Date.parse(FIXTURE.kickoff_at!) - 10 * 60_000;
    let processingDelayMs = 0;
    runtime.deps.tx.createReplaySource = () => ({
      start(handler) { emit = handler; },
      stop() {},
      currentAsOfMs: () => virtualNowMs,
    });
    const supervisor = new IngestSupervisor(
      { ...runtime.deps, now: () => nowMs },
      {
        onReplayEvent: async () => { nowMs += processingDelayMs; },
      } as unknown as typeof runtime.settler,
    );
    const replayEvent = (seq: number): MatchEvent => ({
      kind: 'stat_update', fixtureId: FIXTURE_ID, seq,
      tsMs: virtualNowMs, receivedAtMs: nowMs, confirmed: true,
      phase: 'H1', minute: seq,
      score: {
        p1: { goals: 0, yellowCards: 0, redCards: 0, corners: 0 },
        p2: { goals: 0, yellowCards: 0, redCards: 0, corners: 0 },
        p1Goals90: 0, p2Goals90: 0,
      },
    });

    await supervisor.startReplay(GROUP_ID, FIXTURE, REPLAY_SPEED);
    virtualNowMs = Date.parse(FIXTURE.kickoff_at!);
    processingDelayMs = 220_000;
    await emit?.(replayEvent(1));

    virtualNowMs += 60_000;
    processingDelayMs = 10_000;
    await emit?.(replayEvent(2));
    expect(runtime.log.events.filter(({ event }) => event === 'replay_processing_lag')).toHaveLength(1);

    nowMs += 61_000;
    virtualNowMs += 60_000;
    processingDelayMs = 0;
    await emit?.(replayEvent(3));
    expect(runtime.log.events.filter(({ event }) => event === 'replay_processing_lag')).toHaveLength(2);

    virtualNowMs += 8 * 60_000;
    await emit?.(replayEvent(4));
    expect(runtime.log.events.filter(({ event }) => event === 'replay_processing_lag_recovered'))
      .toHaveLength(1);
  });
});
