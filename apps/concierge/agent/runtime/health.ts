import type { ConciergeReadinessEvaluator } from './readiness.js';

export function liveResponse(): Response {
  return Response.json({ status: 'live' });
}

export async function readyResponse(
  readiness: ConciergeReadinessEvaluator,
): Promise<Response> {
  const report = await readiness.evaluate();
  return Response.json(report, { status: report.status === 'ready' ? 200 : 503 });
}
