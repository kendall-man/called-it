import type { MatchEvent } from '@calledit/market-engine';

/**
 * The single ingestion contract: LiveSource (SSE) and ReplaySource (virtual
 * clock over asOf snapshots) both implement it, so the downstream pipeline is
 * byte-for-byte identical in live and replay mode.
 */
export interface MatchEventSource {
  start(onEvent: (event: MatchEvent) => Promise<void>): void;
  stop(): void;
}

/**
 * Persistence for SSE Last-Event-ID resume cursors — injected so apps/engine
 * can back it with the stream_cursors table while tests stay in memory.
 */
export interface CursorStore {
  get(name: string): Promise<string | null>;
  set(name: string, id: string): Promise<void>;
}

export class InMemoryCursorStore implements CursorStore {
  private readonly cursors = new Map<string, string>();

  async get(name: string): Promise<string | null> {
    return this.cursors.get(name) ?? null;
  }

  async set(name: string, id: string): Promise<void> {
    this.cursors.set(name, id);
  }
}

/** Resolves after `ms`, or immediately when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const finish = (): void => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    function onAbort(): void {
      clearTimeout(timer);
      finish();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
