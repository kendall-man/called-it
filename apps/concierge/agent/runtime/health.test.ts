import { describe, expect, it } from 'vitest';
import { liveResponse, readyResponse } from './health.js';

describe('concierge health responses', () => {
  it('reports process liveness without reading configuration or dependencies', async () => {
    const response = liveResponse();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'live' });
  });

  it('uses 200 and 503 with reason-code-only readiness JSON', async () => {
    const healthy = await readyResponse({
      evaluate: async () => ({ status: 'ready', reasons: [] }),
    });
    const draining = await readyResponse({
      evaluate: async () => ({ status: 'not_ready', reasons: ['draining'] }),
    });

    expect(healthy.status).toBe(200);
    expect(await healthy.json()).toEqual({ status: 'ready', reasons: [] });
    expect(draining.status).toBe(503);
    expect(await draining.json()).toEqual({
      status: 'not_ready',
      reasons: ['draining'],
    });
  });
});
