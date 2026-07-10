import { z } from 'zod';
import type { EngineReadinessPort } from './readiness.js';

const EngineReadinessBody = z
  .object({
    status: z.enum(['ready', 'not_ready']),
    reasons: z.array(z.string()),
  })
  .strict();

export interface HttpEngineReadinessOptions {
  readonly baseUrl: string;
  readonly request: typeof fetch;
}

export function createHttpEngineReadinessPort(
  options: HttpEngineReadinessOptions,
): EngineReadinessPort {
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  return {
    async probe(signal) {
      const response = await options.request(`${baseUrl}/api/ready`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal,
      });
      const parsed = await response.json().then(
        (body) => EngineReadinessBody.safeParse(body),
        () => null,
      );
      if (parsed === null || !parsed.success) return 'invalid';
      if (response.status === 200 && parsed.data.status === 'ready') return 'ready';
      if (response.status === 503 && parsed.data.status === 'not_ready') return 'not_ready';
      return 'invalid';
    },
  };
}
