import { computeTelegramRetryAtMs } from './retry-policy.js';
import { TelegramIngressWorkerLifecycle } from './ingress-worker-lifecycle.js';

const STABLE_ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

export type TelegramIngressPayload = Readonly<Record<string, unknown>>;

export interface TelegramIngressLeasedUpdate {
  readonly id: string;
  readonly attempts: number;
  readonly sourceFingerprint: string;
  readonly payload: TelegramIngressPayload;
}

export type TelegramIngressTransitionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string };

export interface TelegramIngressWorkerDb {
  heartbeatWorker(workerKind: 'telegram_ingress', workerId: string, stopping: boolean): Promise<void>;
  leaseUpdates(workerId: string, limit: number, leaseMs: number): Promise<readonly TelegramIngressLeasedUpdate[]>;
  completeUpdate(updateRowId: string, workerId: string): Promise<TelegramIngressTransitionResult>;
  retryUpdate(input: {
    readonly updateRowId: string;
    readonly workerId: string;
    readonly errorCode: string;
    readonly retryAt: string;
    readonly maxAttempts: number;
  }): Promise<TelegramIngressTransitionResult>;
  deadLetterUpdate(
    updateRowId: string,
    workerId: string,
    errorCode: string,
  ): Promise<TelegramIngressTransitionResult>;
}

export type TelegramIngressHandler = (
  payload: TelegramIngressPayload,
  signal: AbortSignal,
) => Promise<void>;

export interface TelegramIngressWorkerLogger {
  warn(
    event: 'telegram_ingress_handler_failed' | 'telegram_ingress_completion_rejected',
    fields: Readonly<{ sourceFingerprint: string; attempt: number; code: string }>,
  ): void;
}

export interface TelegramIngressClock {
  now(): number;
}

export interface TelegramIngressRandom {
  next(): number;
}

export interface TelegramIngressQueuePolicy {
  readonly batchSize: number;
  readonly leaseMs: number;
  readonly maxAttempts: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
}

export interface TelegramIngressWorkerOptions {
  readonly db: TelegramIngressWorkerDb;
  readonly handler: TelegramIngressHandler;
  readonly logger: TelegramIngressWorkerLogger;
  readonly clock: TelegramIngressClock;
  readonly random: TelegramIngressRandom;
  readonly queuePolicy: TelegramIngressQueuePolicy;
  readonly workerId: string;
}

export class TelegramIngressPermanentError extends Error {
  readonly name = 'TelegramIngressPermanentError';
  readonly code: string;

  constructor(code: string) {
    super();
    this.code = stableErrorCode(code, 'permanent_failure');
  }
}

export class TelegramIngressWorkerConfigError extends Error {
  readonly name = 'TelegramIngressWorkerConfigError';
  readonly code:
    | 'invalid_batch_size'
    | 'invalid_lease_ms'
    | 'invalid_max_attempts'
    | 'invalid_retry_base_ms'
    | 'invalid_retry_max_ms';

  constructor(code: TelegramIngressWorkerConfigError['code']) {
    super(code);
    this.code = code;
  }
}

export class TelegramIngressWorker {
  private readonly lifecycle = new TelegramIngressWorkerLifecycle();

  constructor(private readonly options: TelegramIngressWorkerOptions) {
    validateQueuePolicy(options.queuePolicy);
  }

  async runOnce(signal: AbortSignal): Promise<number> {
    await this.heartbeat(false);
    try {
      if (this.lifecycle.leasingStopped || signal.aborted) return 0;
      const tasks = await this.startLeasedWork(signal);
      const outcomes = await Promise.allSettled(tasks);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') throw outcome.reason;
      }
      return tasks.length;
    } finally {
      await this.heartbeat(this.lifecycle.leasingStopped);
    }
  }

  stopLeasing(): void {
    this.lifecycle.stopLeasing();
  }

  async drain(signal: AbortSignal): Promise<void> {
    await this.lifecycle.drain(signal);
  }

  unfinished(): number {
    return this.lifecycle.unfinished();
  }

  private async startLeasedWork(signal: AbortSignal): Promise<readonly Promise<void>[]> {
    const finishLease = this.lifecycle.beginLease();
    try {
      const leased = await this.options.db.leaseUpdates(
        this.options.workerId,
        this.options.queuePolicy.batchSize,
        this.options.queuePolicy.leaseMs,
      );
      return leased.map((item) => this.lifecycle.track(this.processLease(item, signal)));
    } finally {
      finishLease();
    }
  }

  private async processLease(item: TelegramIngressLeasedUpdate, signal: AbortSignal): Promise<void> {
    try {
      await this.options.handler(item.payload, signal);
    } catch (error) {
      await this.handleHandlerFailure(item, error);
      return;
    }
    const result = await this.options.db.completeUpdate(item.id, this.options.workerId);
    if (!result.ok) {
      this.log('telegram_ingress_completion_rejected', item, stableErrorCode(result.code, 'completion_rejected'));
    }
  }

  private async handleHandlerFailure(item: TelegramIngressLeasedUpdate, error: unknown): Promise<void> {
    if (error instanceof TelegramIngressPermanentError) {
      await this.deadLetter(item, error.code);
      return;
    }
    if (error instanceof Error) {
      await this.retry(item, 'handler_error');
      return;
    }
    try {
      await this.retry(item, 'unknown_exception');
    } finally {
      throw error;
    }
  }

  private async retry(item: TelegramIngressLeasedUpdate, errorCode: string): Promise<void> {
    const retryAtMs = computeTelegramRetryAtMs({
      nowMs: this.options.clock.now(),
      attempt: item.attempts,
      retryBaseMs: this.options.queuePolicy.retryBaseMs,
      retryMaxMs: this.options.queuePolicy.retryMaxMs,
      randomValue: this.options.random.next(),
    });
    const result = await this.options.db.retryUpdate({
      updateRowId: item.id,
      workerId: this.options.workerId,
      errorCode,
      retryAt: new Date(retryAtMs).toISOString(),
      maxAttempts: this.options.queuePolicy.maxAttempts,
    });
    this.log('telegram_ingress_handler_failed', item, result.ok ? errorCode : stableErrorCode(result.code, 'retry_rejected'));
  }

  private async deadLetter(item: TelegramIngressLeasedUpdate, errorCode: string): Promise<void> {
    const result = await this.options.db.deadLetterUpdate(item.id, this.options.workerId, errorCode);
    this.log('telegram_ingress_handler_failed', item, result.ok ? errorCode : stableErrorCode(result.code, 'dead_letter_rejected'));
  }

  private async heartbeat(stopping: boolean): Promise<void> {
    await this.options.db.heartbeatWorker('telegram_ingress', this.options.workerId, stopping);
  }

  private log(
    event: 'telegram_ingress_handler_failed' | 'telegram_ingress_completion_rejected',
    item: TelegramIngressLeasedUpdate,
    code: string,
  ): void {
    this.options.logger.warn(event, {
      sourceFingerprint: item.sourceFingerprint,
      attempt: item.attempts,
      code,
    });
  }
}

function validateQueuePolicy(policy: TelegramIngressQueuePolicy): void {
  if (!isIntegerInRange(policy.batchSize, 1, 100)) {
    throw new TelegramIngressWorkerConfigError('invalid_batch_size');
  }
  if (!isIntegerInRange(policy.leaseMs, 1, 86_400_000)) {
    throw new TelegramIngressWorkerConfigError('invalid_lease_ms');
  }
  if (!isIntegerInRange(policy.maxAttempts, 1, 100)) {
    throw new TelegramIngressWorkerConfigError('invalid_max_attempts');
  }
  if (!isIntegerInRange(policy.retryBaseMs, 1, 86_400_000)) {
    throw new TelegramIngressWorkerConfigError('invalid_retry_base_ms');
  }
  if (!isIntegerInRange(policy.retryMaxMs, policy.retryBaseMs, 86_400_000)) {
    throw new TelegramIngressWorkerConfigError('invalid_retry_max_ms');
  }
}

function isIntegerInRange(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function stableErrorCode(value: string, fallback: string): string {
  return STABLE_ERROR_CODE.test(value) ? value : fallback;
}
