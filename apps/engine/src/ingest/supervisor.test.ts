import { describe, expect, it } from 'vitest';
import { createTelegramFlowRuntime } from '../points/telegram-points-flow-runtime.test-support.js';
import { IngestSupervisor } from './supervisor.js';

const GROUP_ID = -900_001;
const FIXTURE_ID = 70_001;
const REPLAY_SPEED = 4;

describe('replay logging privacy', () => {
  it('logs replay start diagnostics without Telegram group identity', () => {
    // Given an ingest supervisor serving a Telegram group replay
    const runtime = createTelegramFlowRuntime();
    const supervisor = new IngestSupervisor(runtime.deps, runtime.settler);

    // When the replay starts
    supervisor.startReplay(GROUP_ID, FIXTURE_ID, REPLAY_SPEED);

    // Then only fixture-domain diagnostics are logged
    expect(runtime.log.events.find(({ event }) => event === 'replay_started')?.fields).toEqual({
      fixtureId: FIXTURE_ID,
      speed: REPLAY_SPEED,
    });
  });

  it('logs replay stop diagnostics without Telegram group identity', () => {
    // Given an active Telegram group replay
    const runtime = createTelegramFlowRuntime();
    const supervisor = new IngestSupervisor(runtime.deps, runtime.settler);
    supervisor.startReplay(GROUP_ID, FIXTURE_ID, REPLAY_SPEED);

    // When the replay stops
    supervisor.stopReplay(GROUP_ID);

    // Then only the safe fixture ID is logged
    expect(runtime.log.events.find(({ event }) => event === 'replay_stopped')?.fields).toEqual({
      fixtureId: FIXTURE_ID,
    });
  });
});
