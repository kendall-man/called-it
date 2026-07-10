/**
 * Compatibility seam for callers that still hand proof work to the settler.
 * Durable queue ownership lives in settle/recovery-runtime.ts; this class has
 * deliberately no timers so a process restart cannot discard scheduled work.
 */

import type { Comparator } from '@calledit/market-engine';
import type { Deps } from '../ports.js';

export interface ProofJob {
  readonly marketId: string;
  readonly fixtureId: number;
  readonly seq: number;
  readonly statKey: number;
  readonly comparator: Comparator;
  readonly threshold: number;
}

export interface DurableProofEnqueuer {
  enqueue(job: ProofJob): Promise<void>;
}

export class ProofWorker {
  private stopped = false;

  constructor(
    private readonly deps: Deps,
    private readonly queue: DurableProofEnqueuer | null = null,
  ) {}

  async enqueue(job: ProofJob): Promise<void> {
    if (this.stopped) return;
    if (this.queue === null) {
      this.deps.log.warn('proof_enqueue_deferred_until_durable_runtime', { marketId: job.marketId });
      return;
    }
    await this.queue.enqueue(job);
  }

  stop(): void {
    this.stopped = true;
  }
}
