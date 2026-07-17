import type { DrainState } from './readiness.js';

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export interface ShutdownDrainPort {
  readonly name: string;
  drain(signal: AbortSignal): Promise<void>;
  unfinished(): number;
}

export interface ShutdownDeadlinePort {
  wait(timeoutMs: number, signal: AbortSignal): Promise<void>;
}

export interface BoundedShutdownOptions {
  readonly timeoutMs: number;
  readonly deadline: ShutdownDeadlinePort;
  readonly drainState: DrainState;
  readonly stopIntake: () => void;
  readonly closeResources: (signal: AbortSignal) => Promise<void>;
  readonly drains: readonly ShutdownDrainPort[];
}

export interface ShutdownResult {
  readonly exitCode: 0 | 1;
  readonly timedOut: boolean;
  readonly unfinishedCount: number;
  readonly unfinished: Readonly<Record<string, number>>;
}

export type ShutdownSignal = 'SIGINT' | 'SIGTERM';

export interface ShutdownSignalHandlerOptions {
  readonly shutdown: (signal: ShutdownSignal) => Promise<ShutdownResult>;
  readonly exit: (code: 0 | 1) => void;
  readonly repeated: (signal: ShutdownSignal) => void;
}

type ShutdownOutcome =
  | { readonly kind: 'completed' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'timeout' };

export async function runBoundedShutdown(
  options: BoundedShutdownOptions,
): Promise<ShutdownResult> {
  options.drainState.begin();
  const controller = new AbortController();
  const operation = (async () => {
    options.stopIntake();
    await options.closeResources(controller.signal);
    await Promise.all(options.drains.map((drain) => drain.drain(controller.signal)));
  })().then<ShutdownOutcome, ShutdownOutcome>(
    () => ({ kind: 'completed' }),
    () => ({ kind: 'failed' }),
  );
  const timeout = options.deadline
    .wait(options.timeoutMs, controller.signal)
    .then<ShutdownOutcome>(() => ({ kind: 'timeout' }));
  const outcome = await Promise.race([operation, timeout]);
  controller.abort();

  const unfinished: Record<string, number> = {};
  let unfinishedCount = 0;
  for (const drain of options.drains) {
    const count = Math.max(0, Math.trunc(drain.unfinished()));
    if (count === 0) continue;
    unfinished[drain.name] = count;
    unfinishedCount += count;
  }
  const timedOut = outcome.kind === 'timeout';
  const failed = outcome.kind !== 'completed' || unfinishedCount > 0;
  return {
    exitCode: failed ? 1 : 0,
    timedOut,
    unfinishedCount,
    unfinished,
  };
}

export function createShutdownSignalHandler(
  options: ShutdownSignalHandlerOptions,
): (signal: ShutdownSignal) => void {
  let started = false;
  let forced = false;
  return (signal) => {
    if (started) {
      options.repeated(signal);
      if (!forced) {
        forced = true;
        options.exit(1);
      }
      return;
    }
    started = true;
    void options.shutdown(signal).then(
      (result) => {
        if (!forced) options.exit(result.exitCode);
      },
      () => {
        if (!forced) options.exit(1);
      },
    );
  };
}
