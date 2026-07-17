/**
 * Registry of scheduled matches + point-in-time queries. Snapshots follow the
 * real feed's semantics: "everything that has happened as of T" — so replay
 * (asOf polling) and live (SSE) both derive from the same materialized
 * timeline, exactly like production TxLINE.
 */

import { MOCKLINE } from './constants.js';
import { materializeMatch } from './materialize.js';
import type { MatchScript, MaterializedMatch, WireRecord } from './types.js';

export type StreamKind = 'scores' | 'odds';

export interface StreamCursor {
  wallTs: number;
  ordinal: number;
}

export interface StreamFrame {
  /** SSE id — `<wallTs>:<ordinal>`, echoed back by Last-Event-ID resume. */
  id: string;
  data: string;
  wallTs: number;
  ordinal: number;
}

export interface MatchStatus {
  fixtureId: number;
  label: string;
  kickoffAt: string;
  timeScale: number;
  phase: string;
  finished: boolean;
  emitted: { scores: number; odds: number };
  total: { scores: number; odds: number };
}

/** StatusId ordinal → display name, for /mock/status only. */
const STATUS_NAME_BY_ORDINAL: Readonly<Record<number, string>> = {
  1: 'NS', 2: 'H1', 3: 'HT', 4: 'H2', 5: 'F',
  6: 'WET', 7: 'ET1', 8: 'HTET', 9: 'ET2', 10: 'FET', 15: 'ABD',
};

export function parseCursor(lastEventId: string | null): StreamCursor | null {
  if (lastEventId === null || lastEventId === '') return null;
  const [tsPart, ordinalPart] = lastEventId.split(':');
  const wallTs = Number(tsPart);
  const ordinal = Number(ordinalPart);
  if (!Number.isFinite(wallTs) || !Number.isFinite(ordinal)) return null;
  return { wallTs, ordinal };
}

export class MatchStore {
  private readonly matches = new Map<number, MaterializedMatch>();
  private nextLiveFixtureId: number = MOCKLINE.LIVE_FIXTURE_ID_BASE;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Schedule a live match kicking off `kickoffInMs` from now. */
  scheduleLive(script: MatchScript, kickoffInMs: number, timeScale: number): MaterializedMatch {
    const fixtureId = this.nextLiveFixtureId++;
    const nowMs = this.now();
    const match = materializeMatch({
      script,
      fixtureId,
      kickoffWallMs: nowMs + kickoffInMs,
      timeScale,
      scheduledAtMs: nowMs,
    });
    this.matches.set(fixtureId, match);
    return match;
  }

  /** Schedule an already-completed match (the /replay target), real spacing. */
  scheduleFinished(script: MatchScript, fixtureId: number): MaterializedMatch {
    const REAL_TIME = 1;
    const nowMs = this.now();
    const match = materializeMatch({
      script,
      fixtureId,
      kickoffWallMs: nowMs - MOCKLINE.REPLAY_ANCHOR_AGO_MS,
      timeScale: REAL_TIME,
      scheduledAtMs: nowMs,
    });
    this.matches.set(fixtureId, match);
    return match;
  }

  reset(): void {
    this.matches.clear();
    this.nextLiveFixtureId = MOCKLINE.LIVE_FIXTURE_ID_BASE;
  }

  fixtures(): WireRecord[] {
    return [...this.matches.values()].map((match) => match.fixture);
  }

  /** Scores snapshots are the full event log as of T (the feed's semantics). */
  scoresSnapshot(fixtureId: number, asOfMs?: number): WireRecord[] {
    const match = this.matches.get(fixtureId);
    if (!match) return [];
    const horizon = asOfMs ?? this.now();
    return match.scores
      .filter((entry) => entry.wallTs <= horizon)
      .map((entry) => entry.record);
  }

  /**
   * Odds snapshots are point-in-time BOOK STATE: the latest record per market
   * line as of T. (An append-log here would leave a scripted suspension
   * looking "suspended forever" to replay consumers.)
   */
  oddsSnapshot(fixtureId: number, asOfMs?: number): WireRecord[] {
    const match = this.matches.get(fixtureId);
    if (!match) return [];
    const horizon = asOfMs ?? this.now();
    const latestByMarket = new Map<string, WireRecord>();
    for (const entry of match.odds) {
      if (entry.wallTs > horizon) continue;
      const marketKey = `${String(entry.record.SuperOddsType)}|${String(entry.record.MarketParameters ?? '')}`;
      latestByMarket.set(marketKey, entry.record); // entries are wallTs-ordered
    }
    return [...latestByMarket.values()];
  }

  /**
   * Stream frames after `cursor` whose wall time has arrived. A null cursor
   * yields the fixture's full visible history — the engine dedupes on
   * (fixture_id, seq), so replaying from the start on a fresh subscription is
   * safe and makes engine restarts mid-match lossless.
   */
  framesSince(
    kind: StreamKind,
    fixtureId: number | undefined,
    cursor: StreamCursor | null,
  ): StreamFrame[] {
    const horizon = this.now();
    const frames: StreamFrame[] = [];
    for (const match of this.matches.values()) {
      if (fixtureId !== undefined && match.fixtureId !== fixtureId) continue;
      match[kind].forEach((entry, index) => {
        if (entry.wallTs > horizon) return;
        const ordinal = index + 1;
        if (
          cursor !== null &&
          (entry.wallTs < cursor.wallTs ||
            (entry.wallTs === cursor.wallTs && ordinal <= cursor.ordinal))
        ) {
          return;
        }
        frames.push({
          id: `${entry.wallTs}:${ordinal}`,
          data: JSON.stringify(entry.record),
          wallTs: entry.wallTs,
          ordinal,
        });
      });
    }
    frames.sort((a, b) => a.wallTs - b.wallTs || a.ordinal - b.ordinal);
    return frames;
  }

  status(): MatchStatus[] {
    const nowMs = this.now();
    return [...this.matches.values()].map((match) => {
      const visibleScores = match.scores.filter((entry) => entry.wallTs <= nowMs);
      const visibleOdds = match.odds.filter((entry) => entry.wallTs <= nowMs);
      const lastStatusId = [...visibleScores]
        .reverse()
        .map((entry) => entry.record.StatusId as number | undefined)
        .find((statusId) => statusId !== undefined);
      const phase =
        lastStatusId !== undefined ? (STATUS_NAME_BY_ORDINAL[lastStatusId] ?? 'NS') : 'NS';
      return {
        fixtureId: match.fixtureId,
        label: `${match.script.home.name} vs ${match.script.away.name}`,
        kickoffAt: new Date(match.kickoffWallMs).toISOString(),
        timeScale: match.timeScale,
        phase,
        finished: visibleScores.length === match.scores.length && phase !== 'NS',
        emitted: { scores: visibleScores.length, odds: visibleOdds.length },
        total: { scores: match.scores.length, odds: match.odds.length },
      };
    });
  }
}
