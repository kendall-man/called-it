import {
  assertNever,
  toResolverOutcome,
  validateOptions,
  waitForCycles,
  type ReconcileOutcome,
  type ReconciliationFailureCode,
  type ResolverOutcome,
} from './ownership-reconciler-helpers.js';
import type {
  TelegramOwnershipReconcilerOptions,
  TelegramOwnershipReconciliationJob,
} from './ownership-reconciler-types.js';

export { createMarketCardOwnershipResolver } from './ownership-reconciler-helpers.js';
export {
  TelegramOwnershipReconcilerConfigurationError,
  type MarketCardEvidencePort,
  type TelegramOwnershipMutationResult,
  type TelegramOwnershipReconcilerOptions,
  type TelegramOwnershipReconcilerPort,
  type TelegramOwnershipReconciliationJob,
  type TelegramOwnershipResolver,
  type TelegramOwnershipResolverRegistry,
} from './ownership-reconciler-types.js';

export class TelegramOwnershipReconciler {
  readonly name: 'telegram_ownership_reconciler' = 'telegram_ownership_reconciler';

  private acceptingLeases = true;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly cycles = new Set<Promise<number>>();

  constructor(private readonly options: TelegramOwnershipReconcilerOptions) {
    validateOptions(options);
  }

  runOnce(signal: AbortSignal): Promise<number> {
    const cycle = this.runOnceInternal(signal);
    this.cycles.add(cycle);
    const clearCycle = () => {
      this.cycles.delete(cycle);
    };
    void cycle.then(clearCycle, clearCycle);
    return cycle;
  }

  stopLeasing(): void {
    this.acceptingLeases = false;
  }

  async drain(signal: AbortSignal): Promise<void> {
    this.stopLeasing();
    while (!signal.aborted) {
      const cycles = [...this.cycles];
      if (cycles.length === 0) {
        await this.options.db.heartbeatWorker(this.name, this.options.workerId, true);
        return;
      }
      await waitForCycles(cycles, signal);
    }
  }

  unfinished(): number {
    return this.inFlight.size;
  }

  private async runOnceInternal(signal: AbortSignal): Promise<number> {
    if (!this.acceptingLeases || signal.aborted) return 0;

    await this.options.db.heartbeatWorker(this.name, this.options.workerId, false);
    if (!this.acceptingLeases || signal.aborted) return 0;

    const jobs = await this.options.db.leaseUncertainOwnership(
      this.options.workerId,
      this.options.batchSize,
      this.options.leaseMs,
    );
    await Promise.all(jobs.map((job) => this.track(job)));

    if (this.acceptingLeases && !signal.aborted) {
      await this.options.db.heartbeatWorker(this.name, this.options.workerId, false);
    }
    return jobs.length;
  }

  private track(job: TelegramOwnershipReconciliationJob): Promise<void> {
    const work = this.reconcile(job).then(
      () => undefined,
      () => undefined,
    );
    this.inFlight.add(work);
    void work.then(() => {
      this.inFlight.delete(work);
    });
    return work;
  }

  private async reconcile(job: TelegramOwnershipReconciliationJob): Promise<void> {
    const resolver = this.options.resolvers[job.domainKind];
    if (resolver === undefined) {
      await this.retryOrManualReview(job, 'unknown_domain_kind');
      return;
    }

    const outcome: ResolverOutcome = await resolver(job.domainId, job.chatId).then(
      (messageId) => toResolverOutcome(messageId),
      () => ({ kind: 'resolver_failed' }),
    );
    switch (outcome.kind) {
      case 'found':
        await this.commitReconciliation(job, outcome.messageId);
        return;
      case 'invalid':
        await this.retryOrManualReview(job, 'invalid_authoritative_id');
        return;
      case 'missing':
        await this.retryOrManualReview(job, 'authoritative_id_missing');
        return;
      case 'resolver_failed':
        await this.retryOrManualReview(job, 'resolver_failed');
        return;
      default:
        return assertNever(outcome);
    }
  }

  private async commitReconciliation(
    job: TelegramOwnershipReconciliationJob,
    messageId: number,
  ): Promise<void> {
    const outcome: ReconcileOutcome = await this.options.db
      .reconcileOutbound(job.id, this.options.workerId, messageId)
      .then(
        (result): ReconcileOutcome =>
          result.ok ? { kind: 'reconciled' } : { kind: 'reconcile_rejected' },
        (): ReconcileOutcome => ({ kind: 'reconcile_failed' }),
      );
    switch (outcome.kind) {
      case 'reconciled':
        return;
      case 'reconcile_failed':
        await this.retryOrManualReview(job, 'reconcile_failed');
        return;
      case 'reconcile_rejected':
        await this.retryOrManualReview(job, 'reconcile_rejected');
        return;
      default:
        return assertNever(outcome);
    }
  }

  private async retryOrManualReview(
    job: TelegramOwnershipReconciliationJob,
    errorCode: ReconciliationFailureCode,
  ): Promise<void> {
    // The uncertain lease expiry schedules the next reconciliation without reopening sending.
    if (job.reconcileAttempts < this.options.maxAttempts) return;

    await this.options.db.manualReviewOutbound(job.id, this.options.workerId, errorCode).then(
      () => undefined,
      () => undefined,
    );
  }
}

export function createTelegramOwnershipReconciler(
  options: TelegramOwnershipReconcilerOptions,
): TelegramOwnershipReconciler {
  return new TelegramOwnershipReconciler(options);
}
