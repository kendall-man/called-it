import { defineChannel, GET } from 'eve/channels';
import { loadConciergeEnv } from '../env.js';
import { createHttpEngineReadinessPort } from '../runtime/engine-readiness.js';
import { liveResponse, readyResponse } from '../runtime/health.js';
import { conciergeLifecycle } from '../runtime/lifecycle.js';
import { installConciergeProcessLifecycle } from '../runtime/process-lifecycle.js';
import {
  SYSTEM_READINESS_DEADLINE,
  createConciergeReadiness,
} from '../runtime/readiness.js';

const env = loadConciergeEnv();
const readiness = createConciergeReadiness({
  runtime: {
    probe: async () => {
      loadConciergeEnv();
    },
  },
  engine: createHttpEngineReadinessPort({
    baseUrl: env.ENGINE_PRIVATE_API_URL,
    request: fetch,
  }),
  runtimeTimeoutMs: env.READINESS_CHECK_TIMEOUT_MS - env.READINESS_ENGINE_TIMEOUT_MS,
  engineTimeoutMs: env.READINESS_ENGINE_TIMEOUT_MS,
  deadline: SYSTEM_READINESS_DEADLINE,
  drain: conciergeLifecycle,
});

installConciergeProcessLifecycle(conciergeLifecycle, env.SHUTDOWN_DRAIN_TIMEOUT_MS);

export default defineChannel({
  routes: [
    GET('/api/live', async () => liveResponse()),
    GET('/api/ready', async () => readyResponse(readiness)),
  ],
});
