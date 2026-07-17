/**
 * End-to-end fidelity: the REAL @calledit/txline consumers (TxlineClient,
 * LiveSource, ReplaySource) run against a live mockline server — proving the
 * SSE wire format, snapshot semantics, and asOf filtering match what the
 * engine consumes in production.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  InMemoryCursorStore,
  LiveSource,
  ReplaySource,
  TxlineClient,
  silentLogger,
} from '@calledit/txline';
import type { MatchEvent } from '@calledit/market-engine';
import { MOCKLINE } from './constants.js';
import { createMocklineServer } from './server.js';
import { MatchStore } from './store.js';
import { WORLDCUP_FINAL } from './scripts/worldcup-final.js';
import type { MatchScript } from './types.js';

const REPLAY_FIXTURE = MOCKLINE.REPLAY_FIXTURE_ID;
const WAIT_TIMEOUT_MS = 10_000;
const WAIT_POLL_MS = 25;

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('mockline server ⇄ real txline consumers', () => {
  let server: Server;
  let store: MatchStore;
  let apiBase: string;
  let client: TxlineClient;

  beforeEach(async () => {
    store = new MatchStore();
    store.scheduleFinished(WORLDCUP_FINAL, REPLAY_FIXTURE);
    const scripts = new Map<string, MatchScript>([[WORLDCUP_FINAL.key, WORLDCUP_FINAL]]);
    server = createMocklineServer({
      store,
      scripts,
      defaultScriptKey: WORLDCUP_FINAL.key,
      pumpIntervalMs: 20,
      heartbeatMs: 1_000,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    client = new TxlineClient({
      apiBase,
      guestJwt: MOCKLINE.MOCK_GUEST_JWT,
      apiToken: MOCKLINE.MOCK_API_TOKEN,
      logger: silentLogger,
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('serves fixtures/scores/odds snapshots that TxlineClient parses', async () => {
    const fixtures = await client.fixturesSnapshot();
    expect(fixtures.map((fixture) => fixture.FixtureId)).toContain(REPLAY_FIXTURE);

    const scores = await client.scoresSnapshot(REPLAY_FIXTURE);
    expect(scores.length).toBeGreaterThan(15);

    // Point-in-time book state: exactly one latest record per market line.
    const odds = await client.oddsSnapshot(REPLAY_FIXTURE);
    expect(odds.map((record) => record.SuperOddsType).sort()).toEqual([
      '1X2_PARTICIPANT_RESULT',
      'OVERUNDER_PARTICIPANT_GOALS',
    ]);
  });

  it('asOf returns the point-in-time view a replay needs', async () => {
    const kickoff = store.status()[0] ? Date.parse(store.status()[0]!.kickoffAt) : 0;
    const beforeKickoff = await client.scoresSnapshot(REPLAY_FIXTURE, kickoff - 1_000);
    const all = await client.scoresSnapshot(REPLAY_FIXTURE);
    expect(beforeKickoff.length).toBeGreaterThan(0); // lineups are out
    expect(beforeKickoff.length).toBeLessThan(all.length);
  });

  it('serves a mappable stat-validation envelope', async () => {
    const proof = await client.statValidation(REPLAY_FIXTURE, 7, 1);
    expect(proof.summary).toBeDefined();
    expect(Array.isArray(proof.statProof)).toBe(true);
  });

  it('ReplaySource replays the finished match to full time', async () => {
    const REPLAY_TEST_SPEED = 200_000; // sleeps become sub-millisecond
    const source = new ReplaySource({
      client,
      fixtureId: REPLAY_FIXTURE,
      speed: REPLAY_TEST_SPEED,
      logger: silentLogger,
    });
    const events: MatchEvent[] = [];
    source.start(async (event) => {
      events.push(event);
    });
    await waitFor(
      () => events.some((event) => event.kind === 'phase_change' && event.phase === 'F'),
      'replay to reach full time',
    );
    source.stop();

    const kinds = events.map((event) => event.kind);
    expect(kinds.filter((kind) => kind === 'goal')).toHaveLength(5);
    expect(kinds).toContain('goal_discarded');
    expect(kinds).toContain('var_check');
    expect(kinds).toContain('odds_suspension');
    const fullTime = events.at(-1);
    expect(fullTime?.score.p1.goals).toBe(3);
    expect(fullTime?.score.p2.goals).toBe(1);
  });

  it('LiveSource consumes the SSE streams end-to-end', async () => {
    // A live match already in progress: kicked off 2h ago in real spacing, so
    // its full history is visible the moment the stream opens.
    const TWO_HOURS_AGO_MS = -2 * 60 * 60_000;
    const REAL_TIME = 1;
    const match = store.scheduleLive(WORLDCUP_FINAL, TWO_HOURS_AGO_MS, REAL_TIME);

    const source = new LiveSource({
      client,
      cursorStore: new InMemoryCursorStore(),
      fixtureId: match.fixtureId,
      logger: silentLogger,
    });
    const events: MatchEvent[] = [];
    source.start(async (event) => {
      events.push(event);
    });
    await waitFor(
      () => events.some((event) => event.kind === 'phase_change' && event.phase === 'F'),
      'live stream to deliver the full match',
    );
    source.stop();

    const kinds = events.map((event) => event.kind);
    expect(kinds.filter((kind) => kind === 'goal')).toHaveLength(5);
    expect(kinds).toContain('goal_discarded');
    const fullTime = events.at(-1);
    expect(fullTime?.score.p1.goals).toBe(3);
  });

  it('the director API schedules matches and reports status', async () => {
    const response = await fetch(`${apiBase}/mock/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inMinutes: 20, timeScale: 12 }),
    });
    expect(response.status).toBe(200);
    const scheduled = (await response.json()) as { fixtureId: number };
    expect(scheduled.fixtureId).toBeGreaterThanOrEqual(MOCKLINE.LIVE_FIXTURE_ID_BASE);

    const status = await fetch(`${apiBase}/mock/status`);
    const body = (await status.json()) as { matches: Array<{ fixtureId: number; phase: string }> };
    expect(body.matches.map((match) => match.fixtureId)).toContain(scheduled.fixtureId);
  });
});
