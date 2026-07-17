import {
  DEFAULT_RETRY_DELAY_MS,
  defaultWait,
  isTelegramMessageId,
} from './owned-sender-contract.js';
import {
  TelegramOutboundCompletionWorkerConfigError,
  type TelegramOutboundCompletionDb,
  type TelegramOutboundCompletionDrainResult,
  type TelegramOutboundCompletionLease,
  type TelegramOutboundCompletionResult,
  type TelegramOutboundCompletionWorkerOptions,
} from './outbound-completion-contract.js';

export {
  TelegramOutboundCompletionWorkerConfigError,
  type TelegramOutboundCompletionDb,
  type TelegramOutboundCompletionDrainResult,
  type TelegramOutboundCompletionHandler,
  type TelegramOutboundCompletionLease,
  type TelegramOutboundCompletionRegistry,
  type TelegramOutboundCompletionResult,
  type TelegramOutboundCompletionState,
  type TelegramOutboundCompletionWorkerOptions,
} from './outbound-completion-contract.js';

export class TelegramOutboundCompletionWorker {
  readonly name = 'telegram_outbound_completion';

  private acceptingLeases = true;
  private readonly cycles = new Set<Promise<number>>();
  private readonly inFlight = new Map<string, Promise<TelegramOutboundCompletionResult>>();
  private readonly now: () => number;
  private readonly retryDelayMs: number;
  private readonly wait: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: TelegramOutboundCompletionWorkerOptions) {
    validateOptions(options);
    this.now = options.now ?? Date.now;
    this.retryDelayMs = Math.max(0, Math.trunc(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS));
    this.wait = options.wait ?? defaultWait;
  }

  runOnce(signal: AbortSignal): Promise<number> {
    const cycle = this.runOnceInternal(signal);
    this.cycles.add(cycle);
    void cycle.then(
      () => this.cycles.delete(cycle),
      () => this.cycles.delete(cycle),
    );
    return cycle;
  }

  stopLeasing(): void {
    this.acceptingLeases = false;
  }

  async drain(signal: AbortSignal): Promise<TelegramOutboundCompletionDrainResult> {
    this.stopLeasing();
    for (;;) {
      if (signal.aborted) return { kind: 'timeout', unfinished: this.unfinished() };
      const active = [...this.cycles, ...this.inFlight.values()];
      if (active.length === 0) return { kind: 'drained' };
      if (!(await waitForActive(active, signal))) {
        return { kind: 'timeout', unfinished: this.unfinished() };
      }
    }
  }

  unfinished(): number {
    return this.inFlight.size;
  }

  private async runOnceInternal(signal: AbortSignal): Promise<number> {
    if (!this.acceptingLeases || signal.aborted) return 0;
    const jobs = await this.options.db.leaseOutboundCompletion(
      this.options.workerId,
      this.options.batchSize,
      this.options.leaseMs,
    );
    await Promise.all(jobs.map((job) => this.track(job, signal)));
    return jobs.length;
  }

  private track(
    lease: TelegramOutboundCompletionLease,
    signal: AbortSignal,
  ): Promise<TelegramOutboundCompletionResult> {
    const current = this.inFlight.get(lease.id);
    if (current !== undefined) return current;

    const work = this.completeLease(lease, signal);
    this.inFlight.set(lease.id, work);
    void work.then(
      () => this.removeInFlight(lease.id, work),
      () => this.removeInFlight(lease.id, work),
    );
    return work;
  }

  private removeInFlight(jobId: string, work: Promise<TelegramOutboundCompletionResult>): void {
    if (this.inFlight.get(jobId) === work) this.inFlight.delete(jobId);
  }

  private async completeLease(
    lease: TelegramOutboundCompletionLease,
    signal: AbortSignal,
  ): Promise<TelegramOutboundCompletionResult> {
    const deadline = Date.parse(lease.leaseExpiresAt);
    if (!Number.isFinite(deadline) || !isTelegramMessageId(lease.telegramMessageId)) {
      return { kind: 'skipped', jobId: lease.id, code: 'outbound_completion_lease_invalid' };
    }
    if (signal.aborted) return { kind: 'aborted', jobId: lease.id };

    const handler = this.options.handlers[lease.domainKind];
    if (handler === undefined) return { kind: 'skipped', jobId: lease.id, code: 'unknown_domain_kind' };

    const completed = await this.retryWithinLease(deadline, signal, async () => {
      const delivered = await this.attempt(() => handler(lease, signal));
      if (delivered === null || this.now() >= deadline) return false;
      const result = await this.attempt(() => this.options.db.completeOutbound(lease.id, this.options.workerId));
      return result?.ok === true && result.state === 'complete';
    });
    if (completed) return { kind: 'complete', jobId: lease.id };
    return signal.aborted
      ? { kind: 'aborted', jobId: lease.id }
      : { kind: 'lease_expired', jobId: lease.id };
  }

  private async retryWithinLease(
    deadline: number,
    signal: AbortSignal,
    operation: () => Promise<boolean>,
  ): Promise<boolean> {
    for (;;) {
      if (signal.aborted || this.now() >= deadline) return false;
      if (await operation()) return true;
      const remaining = deadline - this.now();
      if (remaining <= 0) return false;
      await this.pause(Math.min(Math.max(1, this.retryDelayMs), remaining));
    }
  }

  private attempt<T>(operation: () => Promise<T>): Promise<T | null> {
    return operation().then(
      (result) => result,
      () => null,
    );
  }

  private async pause(milliseconds: number): Promise<void> {
    await this.wait(milliseconds).then(
      () => undefined,
      () => undefined,
    );
  }
}

function validateOptions(options: TelegramOutboundCompletionWorkerOptions): void {
  if (options.workerId.length === 0) throw new TelegramOutboundCompletionWorkerConfigError();
  if (!isBoundedInteger(options.batchSize, 1, 100)) throw new TelegramOutboundCompletionWorkerConfigError();
  if (!isBoundedInteger(options.leaseMs, 1, 86_400_000)) throw new TelegramOutboundCompletionWorkerConfigError();
}

function isBoundedInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function waitForActive(active: readonly Promise<unknown>[], signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (drained: boolean) => {
      signal.removeEventListener('abort', onAbort);
      resolve(drained);
    };
    const onAbort = () => finish(false);
    signal.addEventListener('abort', onAbort, { once: true });
    void Promise.allSettled(active).then(() => finish(true));
  });
}
