/**
 * Diagnostic channel — TEMPORARY operational instrumentation.
 * Gated on ENGINE_API_TOKEN. Lets us verify the deployed runtime from the
 * outside: environment sanity, GLM egress, engine reachability, and — the
 * decisive one — starting an agent session directly, bypassing Telegram.
 */

import { readdirSync } from 'node:fs';
import { defineChannel, GET, POST } from 'eve/channels';

function authorized(req: Request): boolean {
  const key = new URL(req.url).searchParams.get('key');
  return Boolean(key) && key === process.env.ENGINE_API_TOKEN;
}

async function timedFetch(url: string, init: RequestInit, ms: number) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
    const body = (await res.text()).slice(0, 160);
    return { ok: true, status: res.status, ms: Date.now() - t0, body };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: String(err).slice(0, 200) };
  }
}

export default defineChannel({
  routes: [
    GET('/diag', async (req) => {
      if (!authorized(req)) return new Response('nope', { status: 401 });
      const glm = await timedFetch(
        `${process.env.GLM_BASE_URL ?? 'https://api.z.ai/api/anthropic'}/v1/messages`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': process.env.GLM_API_KEY ?? '',
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'glm-4.6',
            max_tokens: 8,
            messages: [{ role: 'user', content: 'say OK' }],
          }),
        },
        15_000,
      );
      const engine = await timedFetch(
        `${process.env.ENGINE_API_URL ?? ''}/api/health`,
        {},
        8_000,
      );
      let workflowData: string[] = [];
      try {
        workflowData = readdirSync('.workflow-data');
      } catch (err) {
        workflowData = [`unreadable: ${String(err).slice(0, 80)}`];
      }
      return Response.json({
        node: process.version,
        cwd: process.cwd(),
        env: {
          GLM_API_KEY: Boolean(process.env.GLM_API_KEY),
          TELEGRAM_BOT_TOKEN: Boolean(process.env.TELEGRAM_BOT_TOKEN),
          CONCIERGE_BOT_USERNAME: process.env.CONCIERGE_BOT_USERNAME ?? null,
          ENGINE_API_URL: process.env.ENGINE_API_URL ?? null,
        },
        glm,
        engine,
        workflowData,
      });
    }),
    POST('/diag/turn', async (req, { send }) => {
      if (!authorized(req)) return new Response('nope', { status: 401 });
      const session = await send('In one short sentence: are you alive and which tools can you see?', {
        auth: null,
      });
      return Response.json({ sessionId: session.id });
    }),
    GET('/diag/session/:sessionId/stream', async (req, { getSession, params }) => {
      if (!authorized(req)) return new Response('nope', { status: 401 });
      const session = getSession(params.sessionId ?? '');
      const stream = await session.getEventStream();
      return new Response(stream, {
        headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
      });
    }),
  ],
  events: {
    'message.completed'(event) {
      // Land the reply in Railway logs so the turn is observable server-side.
      console.log('[diag] message.completed:', JSON.stringify(event).slice(0, 300));
    },
  },
});
