import { describe, expect, it, vi } from 'vitest';
import type { MatchEvent, OddsInputs } from '@calledit/market-engine';
import { silentLogger } from './logging.js';
import { ReplaySource, type ReplaySnapshotClient } from './replay-source.js';
import { oddsRecordSchema, scoresRecordSchema } from './schemas.js';
import {
  FIXTURE_ID,
  KICKOFF_MS,
  oddsRecord,
  period,
  scoreSoccer,
  scoresRecord,
} from './test-fixtures.js';

const MINUTE_MS = 60_000;

/** Synthesized match history: NS → H1 → goal → HT → … → F. */
const SCORES_HISTORY = [
  scoresRecord({
    seq: 1,
    ts: KICKOFF_MS - 10 * MINUTE_MS,
    statusSoccerId: 'NS',
    scoreSoccer: scoreSoccer({ Total: period(0) }, { Total: period(0) }),
  }),
  scoresRecord({ seq: 2, ts: KICKOFF_MS, statusSoccerId: 'H1' }),
  scoresRecord({
    seq: 3,
    ts: KICKOFF_MS + 10 * MINUTE_MS,
    statusSoccerId: 'H1',
    dataSoccer: { Goal: true, Participant: 1, PlayerId: 777, GoalType: 'Shot', Minutes: 10 },
    scoreSoccer: scoreSoccer({ Total: period(1) }, { Total: period(0) }),
  }),
  scoresRecord({ seq: 4, ts: KICKOFF_MS + 45 * MINUTE_MS, statusSoccerId: 'HT' }),
  scoresRecord({ seq: 5, ts: KICKOFF_MS + 60 * MINUTE_MS, statusSoccerId: 'H2' }),
  scoresRecord({
    seq: 6,
    ts: KICKOFF_MS + 95 * MINUTE_MS,
    statusSoccerId: 'F',
    scoreSoccer: scoreSoccer({ Total: period(1) }, { Total: period(0) }),
  }),
];

const ODDS_HISTORY = [
  oddsRecord({ MessageId: 'm1', Ts: KICKOFF_MS - 10 * MINUTE_MS }),
  oddsRecord({ MessageId: 'm2', Ts: KICKOFF_MS + 11 * MINUTE_MS, Pct: ['55.000', '25.000', '20.000'] }),
];

/** asOf-faithful snapshot client: returns state visible at the virtual time. */
function snapshotClient(
  scores: Array<Record<string, unknown>> = SCORES_HISTORY,
  odds: Array<Record<string, unknown>> = ODDS_HISTORY,
): ReplaySnapshotClient {
  return {
    scoresSnapshot: async (_fixtureId, asOfMs) =>
      scores
        .map((raw) => scoresRecordSchema.parse(raw))
        .filter((record) => asOfMs === undefined || record.ts <= asOfMs),
    oddsSnapshot: async (_fixtureId, asOfMs) => {
      const visible = odds
        .map((raw) => oddsRecordSchema.parse(raw))
        .filter((record) => asOfMs === undefined || record.Ts <= asOfMs);
      const latest = visible[visible.length - 1];
      return latest === undefined ? [] : [latest];
    },
  };
}

describe('ReplaySource.stepOnce — snapshot diffing', () => {
  it('replays the full match once, in seq order, without duplicates', async () => {
    const oddsSeen: string[] = [];
    const source = new ReplaySource({
      client: snapshotClient(),
      fixtureId: FIXTURE_ID,
      speed: 30,
      startMs: KICKOFF_MS - 10 * MINUTE_MS,
      tickVirtualMs: 10 * MINUTE_MS,
      onOddsInputs: (_fixtureId, inputs: OddsInputs) => {
        if (inputs.oddsMessageId !== null) oddsSeen.push(inputs.oddsMessageId);
      },
      logger: silentLogger,
    });

    const emitted: MatchEvent[] = [];
    let done = false;
    for (let step = 0; step < 30 && !done; step += 1) {
      const result = await source.stepOnce();
      emitted.push(...result.events);
      done = result.done;
    }

    expect(done).toBe(true);
    expect(emitted.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(emitted.map((e) => e.seq)).size).toBe(emitted.length);

    const goal = emitted.find((e) => e.kind === 'goal');
    expect(goal?.seq).toBe(3);
    expect(goal?.score.p1.goals).toBe(1);
    expect(goal?.score.p1Goals90).toBe(1);
    expect(goal?.detail?.playerNormativeId).toBe(777);

    const last = emitted[emitted.length - 1];
    expect(last?.phase).toBe('F');
    expect(last?.kind).toBe('phase_change');

    // Odds re-emitted only when the pinned MessageId changes.
    expect(oddsSeen).toEqual(['m1', 'm2']);
  });

  it('drains canonical records published after the first terminal record', async () => {
    const postWhistle = scoresRecord({
      seq: 7,
      ts: KICKOFF_MS + 96 * MINUTE_MS,
      statusSoccerId: 'F',
      scoreSoccer: scoreSoccer({ Total: period(1) }, { Total: period(0) }),
    });
    const source = new ReplaySource({
      client: snapshotClient([...SCORES_HISTORY, postWhistle], []),
      fixtureId: FIXTURE_ID,
      speed: 30,
      startMs: KICKOFF_MS - 10 * MINUTE_MS,
      tickVirtualMs: 10 * MINUTE_MS,
      logger: silentLogger,
    });

    const emitted: MatchEvent[] = [];
    let done = false;
    for (let step = 0; step < 30 && !done; step += 1) {
      const result = await source.stepOnce();
      emitted.push(...result.events);
      done = result.done;
    }

    expect(done).toBe(true);
    expect(emitted.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(emitted.at(-1)?.phase).toBe('F');
  });

  it('retries the same virtual boundary after an odds snapshot throttles the tick', async () => {
    const base = snapshotClient(SCORES_HISTORY, []);
    let oddsCalls = 0;
    const source = new ReplaySource({
      client: {
        scoresSnapshot: base.scoresSnapshot,
        async oddsSnapshot(fixtureId, asOfMs) {
          oddsCalls += 1;
          if (oddsCalls === 1) throw new Error('429 Too Many Requests');
          return base.oddsSnapshot(fixtureId, asOfMs);
        },
      },
      fixtureId: FIXTURE_ID,
      speed: 30,
      startMs: KICKOFF_MS - 10 * MINUTE_MS,
      tickVirtualMs: 10 * MINUTE_MS,
      logger: silentLogger,
    });

    await expect(source.stepOnce()).rejects.toThrow('429 Too Many Requests');
    const retried = await source.stepOnce();

    expect(retried.events.map((event) => event.seq)).toEqual([1]);
    expect(retried.virtualNowMs).toBe(KICKOFF_MS - 10 * MINUTE_MS);
  });

  it('probes kickoff from the scores snapshot when startMs is omitted', async () => {
    const source = new ReplaySource({
      client: snapshotClient(),
      fixtureId: FIXTURE_ID,
      speed: 30,
      tickVirtualMs: 10 * MINUTE_MS,
      preKickoffLeadMs: 10 * MINUTE_MS,
      logger: silentLogger,
    });
    const first = await source.stepOnce();
    expect(first.virtualNowMs).toBe(KICKOFF_MS - 10 * MINUTE_MS);
    expect(first.events.map((e) => e.seq)).toEqual([1]);
  });

  it('fails descriptively when kickoff cannot be resolved', async () => {
    const source = new ReplaySource({
      client: snapshotClient([], []),
      fixtureId: FIXTURE_ID,
      speed: 30,
      logger: silentLogger,
    });
    await expect(source.stepOnce()).rejects.toThrow(/cannot resolve kickoff/);
  });

  it('logs one rejection and emits no event for one unsupported odds period', async () => {
    const logger = vi.fn();
    const source = new ReplaySource({
      client: snapshotClient([], [oddsRecord({ MarketPeriod: 'period=FT', Ts: KICKOFF_MS })]),
      fixtureId: FIXTURE_ID,
      speed: 30,
      startMs: KICKOFF_MS,
      logger,
    });

    const result = await source.stepOnce();

    expect(result.events).toEqual([]);
    expect(logger).toHaveBeenCalledOnce();
    expect(logger).toHaveBeenCalledWith(
      'odds period rejected',
      expect.objectContaining({ reason: 'unsupported_period' }),
    );
  });

  it('stops at the max virtual duration when no terminal phase arrives', async () => {
    const neverEnding = [SCORES_HISTORY[0] as Record<string, unknown>];
    const source = new ReplaySource({
      client: snapshotClient(neverEnding, []),
      fixtureId: FIXTURE_ID,
      speed: 30,
      startMs: KICKOFF_MS - 10 * MINUTE_MS,
      tickVirtualMs: 10 * MINUTE_MS,
      maxVirtualMs: 30 * MINUTE_MS,
      logger: silentLogger,
    });
    let done = false;
    let steps = 0;
    while (!done && steps < 10) {
      done = (await source.stepOnce()).done;
      steps += 1;
    }
    expect(done).toBe(true);
    expect(steps).toBe(4); // start, +10, +20, +30 minutes
  });

  it('emits a single odds_suspension edge event during replay', async () => {
    const odds = [
      oddsRecord({ MessageId: 'm1', Ts: KICKOFF_MS - 10 * MINUTE_MS }),
      oddsRecord({ MessageId: 'm-susp', Ts: KICKOFF_MS + 5 * MINUTE_MS, GameState: 'Suspended' }),
      oddsRecord({ MessageId: 'm-back', Ts: KICKOFF_MS + 25 * MINUTE_MS }),
    ];
    const source = new ReplaySource({
      client: snapshotClient(SCORES_HISTORY, odds),
      fixtureId: FIXTURE_ID,
      speed: 30,
      startMs: KICKOFF_MS - 10 * MINUTE_MS,
      tickVirtualMs: 10 * MINUTE_MS,
      logger: silentLogger,
    });

    const emitted: MatchEvent[] = [];
    let done = false;
    for (let step = 0; step < 30 && !done; step += 1) {
      const result = await source.stepOnce();
      emitted.push(...result.events);
      done = result.done;
    }

    const suspensions = emitted.filter((e) => e.kind === 'odds_suspension');
    expect(suspensions).toHaveLength(1);
    // Enriched from the scores stream state, not defaulted.
    expect(suspensions[0]?.phase).toBe('H1');
  });
});

describe('ReplaySource.start — virtual clock pacing', () => {
  it('compensates for successful snapshot processing time without skipping ticks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(KICKOFF_MS);
    const base = snapshotClient();
    const delayed = async <T>(value: Promise<T>): Promise<T> => {
      await new Promise((resolve) => setTimeout(resolve, 7));
      return value;
    };
    const source = new ReplaySource({
      client: {
        scoresSnapshot: (fixtureId, asOfMs) => delayed(base.scoresSnapshot(fixtureId, asOfMs)),
        oddsSnapshot: (fixtureId, asOfMs) => delayed(base.oddsSnapshot(fixtureId, asOfMs)),
      },
      fixtureId: FIXTURE_ID,
      // 10 virtual minutes per tick at 60000× ⇒ one 10ms wall frame.
      speed: 60_000,
      startMs: KICKOFF_MS - 10 * MINUTE_MS,
      tickVirtualMs: 10 * MINUTE_MS,
      logger: silentLogger,
    });
    const emitted: MatchEvent[] = [];
    let endReason: string | null = null;
    source.start(async (event) => {
      emitted.push(event);
    }, (reason) => { endReason = reason; });

    try {
      // Twelve 10ms frames plus the terminal drain fit within 140ms only when
      // the 7ms snapshot work is included in each deadline instead of added to it.
      await vi.advanceTimersByTimeAsync(140);
      expect(emitted.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(endReason).toBe('completed');
    } finally {
      source.stop();
      vi.useRealTimers();
    }
  });

  it('drives the same pipeline end-to-end and stops when done', async () => {
    const source = new ReplaySource({
      client: snapshotClient(),
      fixtureId: FIXTURE_ID,
      // 10 virtual minutes per tick at 60000× ⇒ 10ms real per tick.
      speed: 60_000,
      startMs: KICKOFF_MS - 10 * MINUTE_MS,
      tickVirtualMs: 10 * MINUTE_MS,
      logger: silentLogger,
    });
    const emitted: MatchEvent[] = [];
    let endReason: string | null = null;
    source.start(async (event) => {
      emitted.push(event);
    }, (reason) => { endReason = reason; });
    try {
      await vi.waitFor(() => expect(emitted.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]), {
        timeout: 3_000,
      });
      await vi.waitFor(() => expect(endReason).toBe('completed'));
      const count = emitted.length;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(emitted.length).toBe(count); // loop ended at the terminal phase
    } finally {
      source.stop();
    }
  });

  it('reports a callback failure instead of silently completing', async () => {
    const source = new ReplaySource({
      client: snapshotClient(),
      fixtureId: FIXTURE_ID,
      speed: 60_000,
      startMs: KICKOFF_MS - 10 * MINUTE_MS,
      tickVirtualMs: 10 * MINUTE_MS,
      logger: silentLogger,
    });
    let endReason: string | null = null;

    source.start(
      async () => { throw new Error('settlement failed'); },
      (reason) => { endReason = reason; },
    );

    await vi.waitFor(() => expect(endReason).toBe('failed'));
  });

  it('rejects a non-positive speed and a second start()', () => {
    expect(
      () =>
        new ReplaySource({ client: snapshotClient(), fixtureId: FIXTURE_ID, speed: 0, logger: silentLogger }),
    ).toThrow(/speed/);
    const source = new ReplaySource({
      client: snapshotClient(),
      fixtureId: FIXTURE_ID,
      speed: 60_000,
      startMs: KICKOFF_MS,
      logger: silentLogger,
    });
    source.start(async () => {});
    expect(() => source.start(async () => {})).toThrow(/called twice/);
    source.stop();
  });
});
