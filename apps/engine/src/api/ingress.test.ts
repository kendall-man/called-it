/**
 * Webhook-ingress forwarding: a raw update POSTed to /api/telegram-update
 * reaches the injected grammY handler exactly once, and auth still gates it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { startEngineApi } from './server.js';
import type { Deps } from '../ports.js';
import type { Env } from '../env.js';
import type { Poster } from '../bot/poster.js';
import { DrainState } from './readiness.js';

const TOKEN = 'test-engine-api-token-0123456789';

let activeServer: Server | null = null;
afterEach(() => {
  activeServer?.close();
  activeServer = null;
});

async function startIngress() {
  const received: Array<Record<string, unknown>> = [];
  const server = startEngineApi({
    deps: { log: { info: () => undefined, warn: () => undefined, error: () => undefined } } as unknown as Deps,
    poster: {} as Poster,
    env: { ENGINE_API_TOKEN: TOKEN, PORT: 0, WEB_BASE_URL: 'https://web.test' } as unknown as Env,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    readiness: { evaluate: async () => ({ status: 'ready', reasons: [] }) },
    drainState: new DrainState(),
    handleTelegramUpdate: async (update) => {
      received.push(update);
    },
  });
  if (!server) throw new Error('no server');
  activeServer = server;
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { base: `http://127.0.0.1:${address.port}`, received };
}

describe('telegram-update ingress', () => {
  it('delivers the raw update to the handler', async () => {
    const { base, received } = await startIngress();
    const update = { update_id: 42, message: { text: 'France win today', chat: { id: -1 } } };
    const res = await fetch(`${base}/api/telegram-update`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(update),
    });
    expect(res.status).toBe(200);
    // ack-then-process: give the microtask a beat
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(update);
  });

  it('rejects unauthenticated forwards', async () => {
    const { base, received } = await startIngress();
    const res = await fetch(`${base}/api/telegram-update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ update_id: 1 }),
    });
    expect(res.status).toBe(401);
    expect(received).toHaveLength(0);
  });
});
