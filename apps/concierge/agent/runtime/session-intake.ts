import type { ConciergeLifecycle } from './lifecycle.js';

export interface ConciergeSessionEvents {
  started(sessionId: string): boolean;
  completed(sessionId: string): boolean;
  failed(sessionId: string): boolean;
}

export function createConciergeSessionEvents(
  lifecycle: ConciergeLifecycle,
): ConciergeSessionEvents {
  return {
    started: (sessionId) => lifecycle.beginSession(sessionId),
    completed: (sessionId) => lifecycle.finishSession(sessionId),
    failed: (sessionId) => lifecycle.finishSession(sessionId),
  };
}
