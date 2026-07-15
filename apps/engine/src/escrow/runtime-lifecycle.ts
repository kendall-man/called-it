export interface EscrowRuntimeLifecycleLog {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  error(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface EscrowRuntimeLifecycle {
  start(): void;
  runOnce(): Promise<void>;
  stop(): Promise<void>;
  unfinished(): number;
}

export function createEscrowRuntimeLifecycle(options: {
  readonly attestations: { runOnce(nowIso: string, limit: number): Promise<unknown> };
  readonly relayer: { runOnce(nowIso: string, limit: number): Promise<unknown> };
  readonly indexer: { runOnce(limit: number): Promise<unknown> };
  readonly clock: () => string;
  readonly intervalMs: number;
  readonly relayerLimit: number;
  readonly attestationLimit: number;
  readonly indexerLimit: number;
  readonly log: EscrowRuntimeLifecycleLog;
}): EscrowRuntimeLifecycle {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1) {
    throw new TypeError('escrow lifecycle interval must be a positive integer');
  }
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active: Promise<void> | null = null;

  async function runWorker(name: 'attestations' | 'relayer' | 'indexer', task: () => Promise<unknown>): Promise<void> {
    try {
      await task();
    } catch (error) {
      options.log.error('escrow_worker_cycle_failed', {
        worker: name,
        reason: error instanceof Error ? error.name : 'unknown_exception',
      });
    }
  }

  async function cycle(): Promise<void> {
    await runWorker('attestations', () => options.attestations.runOnce(options.clock(), options.attestationLimit));
    await runWorker('relayer', () => options.relayer.runOnce(options.clock(), options.relayerLimit));
    await runWorker('indexer', () => options.indexer.runOnce(options.indexerLimit));
  }

  function schedule(): void {
    if (!running || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      active = cycle().finally(() => {
        active = null;
        schedule();
      });
    }, options.intervalMs);
  }

  return {
    start() {
      if (running) return;
      running = true;
      options.log.info('escrow_workers_started');
      schedule();
    },
    async runOnce() {
      if (active !== null) return active;
      active = cycle().finally(() => { active = null; });
      return active;
    },
    async stop() {
      if (!running && active === null) return;
      running = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      await active;
      options.log.info('escrow_workers_stopped');
    },
    unfinished() {
      return active === null ? 0 : 1;
    },
  };
}
