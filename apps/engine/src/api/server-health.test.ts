import { afterEach, describe, expect, it } from 'vitest';
import { DrainState, ENGINE_READINESS_REASONS } from './readiness.js';
import {
  CHAT_ID,
  authed,
  closeActiveServer,
  startHarness,
} from './server-test-harness.js';

afterEach(closeActiveServer);

describe('engine health API', () => {
  it('keeps legacy health unavailable while application routes require auth', async () => {
    const harness = await startHarness();
    const bare = await fetch(`${harness.base}/api/groups/${CHAT_ID}/snapshot`);
    const wrong = await fetch(`${harness.base}/api/groups/${CHAT_ID}/snapshot`, {
      headers: { authorization: 'Bearer nope' },
    });
    const health = await fetch(`${harness.base}/api/health`);

    expect(bare.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(health.status).toBe(404);
  });

  it('reports process liveness without authentication or dependency checks', async () => {
    const harness = await startHarness();

    const response = await fetch(`${harness.base}/api/live`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'live' });
  });

  it('reports a healthy dependency set as ready without authentication', async () => {
    const harness = await startHarness();

    const response = await fetch(`${harness.base}/api/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ready', reasons: [] });
  });

  it('reports a failed dependency with only a stable reason code', async () => {
    const harness = await startHarness({
      readiness: {
        evaluate: async () => ({
          status: 'not_ready',
          reasons: [ENGINE_READINESS_REASONS.databaseUnavailable],
        }),
      },
    });

    const response = await fetch(`${harness.base}/api/ready`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: 'not_ready',
      reasons: ['database_unavailable'],
    });
  });

  it('keeps liveness up but rejects readiness and intake while draining', async () => {
    const drainState = new DrainState();
    drainState.begin();
    const harness = await startHarness({ drainState });

    const live = await fetch(`${harness.base}/api/live`);
    const ready = await fetch(`${harness.base}/api/ready`);
    const intake = await fetch(`${harness.base}/api/fixtures`, { headers: authed });

    expect(live.status).toBe(200);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ status: 'not_ready', reasons: ['draining'] });
    expect(intake.status).toBe(503);
    expect(await intake.json()).toEqual({ error: 'draining' });
  });
});
