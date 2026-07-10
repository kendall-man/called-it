export class ConciergeDrainingError extends Error {
  readonly name = 'ConciergeDrainingError';

  constructor() {
    super('concierge_draining');
  }
}

export class ConciergeLifecycle {
  private draining = false;
  private active = 0;
  private readonly sessions = new Set<string>();

  beginSession(sessionId: string): boolean {
    if (this.sessions.has(sessionId)) return false;
    this.sessions.add(sessionId);
    return true;
  }

  finishSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  beginDrain(): boolean {
    if (this.draining) return false;
    this.draining = true;
    return true;
  }

  isDraining(): boolean {
    return this.draining;
  }

  acceptsIntake(): boolean {
    return !this.draining;
  }

  unfinished(): number {
    return this.active + this.sessions.size;
  }

  async track<T>(work: () => Promise<T>): Promise<T> {
    if (this.draining) throw new ConciergeDrainingError();
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
    }
  }
}

export const conciergeLifecycle = new ConciergeLifecycle();

export type ConciergeShutdownSignal = 'SIGINT' | 'SIGTERM';

export interface ConciergeSignalControllerOptions {
  readonly lifecycle: ConciergeLifecycle;
  readonly timeoutMs: number;
  readonly schedule: (callback: () => void, timeoutMs: number) => () => void;
  readonly exit: (code: 1) => void;
  readonly log: (event: string, fields: Readonly<Record<string, string | number>>) => void;
}

export interface ConciergeSignalController {
  signal(signal: ConciergeShutdownSignal): void;
  complete(): 0 | 1 | null;
}

export function createConciergeSignalController(
  options: ConciergeSignalControllerOptions,
): ConciergeSignalController {
  let started = false;
  let forced = false;
  let activeSignal: ConciergeShutdownSignal | null = null;
  let cancelDeadline: (() => void) | null = null;
  let finalExitCode: 0 | 1 | null | undefined;
  return {
    signal(signal) {
      if (started) {
        options.log('concierge_shutdown_repeated_signal', {
          signal,
          unfinishedCount: options.lifecycle.unfinished(),
        });
        if (!forced) {
          forced = true;
          cancelDeadline?.();
          options.exit(1);
        }
        return;
      }
      started = true;
      activeSignal = signal;
      options.lifecycle.beginDrain();
      options.log('concierge_shutdown_started', {
        signal,
        unfinishedCount: options.lifecycle.unfinished(),
      });
      cancelDeadline = options.schedule(() => {
        if (forced) return;
        forced = true;
        options.log('concierge_shutdown_timeout', {
          signal,
          unfinishedCount: options.lifecycle.unfinished(),
        });
        options.exit(1);
      }, options.timeoutMs);
    },
    complete() {
      if (finalExitCode !== undefined) return finalExitCode;
      if (!started || activeSignal === null) {
        finalExitCode = null;
        return finalExitCode;
      }
      cancelDeadline?.();
      const unfinishedCount = options.lifecycle.unfinished();
      if (forced || unfinishedCount > 0) {
        finalExitCode = 1;
        options.log('concierge_shutdown_failed', {
          signal: activeSignal,
          unfinishedCount,
        });
      } else {
        finalExitCode = 0;
        options.log('concierge_shutdown_complete', {
          signal: activeSignal,
          unfinishedCount,
        });
      }
      return finalExitCode;
    },
  };
}
