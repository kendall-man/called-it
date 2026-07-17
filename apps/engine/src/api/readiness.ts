function defineReasonCodes<const Codes extends Readonly<Record<string, string>>>(
  codes: Codes,
): Codes {
  return codes;
}

export const ENGINE_READINESS_REASONS = defineReasonCodes({
  databaseUnavailable: 'database_unavailable',
  databaseTimeout: 'database_timeout',
  feedInactive: 'feed_inactive',
  feedUnavailable: 'feed_unavailable',
  feedTimeout: 'feed_timeout',
  feedStale: 'feed_stale',
  wagerDisabled: 'wager_disabled',
  wagerUnavailable: 'wager_unavailable',
  wagerTimeout: 'wager_timeout',
  wagerPaused: 'wager_paused',
  solvencyUncovered: 'solvency_uncovered',
  telegramWorkerUnavailable: 'telegram_worker_unavailable',
  telegramWorkerTimeout: 'telegram_worker_timeout',
  telegramWorkerStale: 'telegram_worker_stale',
  proofSubmissionDisabled: 'proof_submission_disabled',
  proofWorkerUnavailable: 'proof_worker_unavailable',
  proofWorkerTimeout: 'proof_worker_timeout',
  proofWorkerStale: 'proof_worker_stale',
  proofBacklog: 'proof_backlog',
  proofDeadLetter: 'proof_dead_letter',
  proofOldestStale: 'proof_oldest_stale',
  settlementReconciliationDisabled: 'settlement_reconciliation_disabled',
  settlementWorkerUnavailable: 'settlement_worker_unavailable',
  settlementWorkerTimeout: 'settlement_worker_timeout',
  settlementWorkerStale: 'settlement_worker_stale',
  settlementBacklog: 'settlement_backlog',
  settlementDeadLetter: 'settlement_dead_letter',
  settlementOldestStale: 'settlement_oldest_stale',
  draining: 'draining',
});

export type EngineReadinessReason =
  (typeof ENGINE_READINESS_REASONS)[keyof typeof ENGINE_READINESS_REASONS];

export interface ReadinessReport {
  readonly status: 'ready' | 'not_ready';
  readonly reasons: readonly EngineReadinessReason[];
}

export interface ReadinessEvaluator {
  evaluate(): Promise<ReadinessReport>;
}

export type ReadinessCheckName =
  | 'database'
  | 'feed'
  | 'wager'
  | 'telegram'
  | 'proof'
  | 'settlement';

export type ReadinessCheckResult =
  | { readonly kind: 'ready' }
  | { readonly kind: 'disabled'; readonly reason: EngineReadinessReason }
  | { readonly kind: 'not_ready'; readonly reason: EngineReadinessReason };

export interface ReadinessCheckPort {
  readonly name: ReadinessCheckName;
  readonly unavailableReason: EngineReadinessReason;
  readonly timeoutReason: EngineReadinessReason;
  check(signal: AbortSignal): Promise<ReadinessCheckResult>;
}

export interface ReadinessDeadlinePort {
  wait(timeoutMs: number, signal: AbortSignal): Promise<void>;
}

export const SYSTEM_READINESS_DEADLINE: ReadinessDeadlinePort = {
  wait(timeoutMs, signal) {
    return new Promise<void>((resolve) => {
      if (signal.aborted) return;
      const timer = setTimeout(resolve, timeoutMs);
      signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    });
  },
};

export class DrainState {
  private draining = false;

  begin(): boolean {
    if (this.draining) return false;
    this.draining = true;
    return true;
  }

  isDraining(): boolean {
    return this.draining;
  }
}

export interface ReadinessEvaluatorOptions {
  readonly checks: readonly ReadinessCheckPort[];
  readonly checkTimeoutMs: number;
  readonly deadline: ReadinessDeadlinePort;
  readonly drainState: DrainState;
}

function drainingReport(): ReadinessReport {
  return {
    status: 'not_ready',
    reasons: [ENGINE_READINESS_REASONS.draining],
  };
}

type BoundedCheckOutcome =
  | { readonly kind: 'result'; readonly result: ReadinessCheckResult }
  | { readonly kind: 'timeout' };

async function runBoundedCheck(
  check: ReadinessCheckPort,
  options: ReadinessEvaluatorOptions,
): Promise<ReadinessCheckResult> {
  const controller = new AbortController();
  const completed = check
    .check(controller.signal)
    .then<BoundedCheckOutcome, BoundedCheckOutcome>(
      (result) => ({ kind: 'result', result }),
      () => ({
        kind: 'result',
        result: { kind: 'not_ready', reason: check.unavailableReason },
      }),
    );
  const expired = options.deadline
    .wait(options.checkTimeoutMs, controller.signal)
    .then<BoundedCheckOutcome>(() => ({ kind: 'timeout' }));
  const outcome = await Promise.race([completed, expired]);
  controller.abort();
  if (outcome.kind === 'timeout') {
    return { kind: 'not_ready', reason: check.timeoutReason };
  }
  return outcome.result;
}

export function createReadinessEvaluator(
  options: ReadinessEvaluatorOptions,
): ReadinessEvaluator {
  return {
    async evaluate() {
      if (options.drainState.isDraining()) {
        return drainingReport();
      }
      const results = await Promise.all(
        options.checks.map((check) => runBoundedCheck(check, options)),
      );
      if (options.drainState.isDraining()) {
        return drainingReport();
      }
      const reasons: EngineReadinessReason[] = [];
      let failed = false;
      for (const result of results) {
        if (result.kind === 'ready') continue;
        reasons.push(result.reason);
        if (result.kind === 'not_ready') failed = true;
      }
      return { status: failed ? 'not_ready' : 'ready', reasons };
    },
  };
}
