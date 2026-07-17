import {
  DEFAULT_RETRY_DELAY_MS,
  defaultWait,
  isTelegramMessageId,
  outcomeFromDurableState,
  type OwnedTelegramDrainResult,
  type OwnedTelegramOutboundIdentity,
  type OwnedTelegramOutboundState,
  type OwnedTelegramPlanInput,
  type OwnedTelegramSendInput,
  type OwnedTelegramSenderOptions,
  type OwnedTelegramSendResult,
} from './owned-sender-contract.js';

export type {
  OwnedTelegramActionResult,
  OwnedTelegramCompletionState,
  OwnedTelegramDrainResult,
  OwnedTelegramOutboundIdentity,
  OwnedTelegramPlanInput,
  OwnedTelegramPlanResult,
  OwnedTelegramSenderDb,
  OwnedTelegramSenderOptions,
  OwnedTelegramSendInput,
  OwnedTelegramSendResult,
  OwnedTelegramStartResult,
} from './owned-sender-contract.js';

interface InFlightSend {
  readonly identity: OwnedTelegramPlanInput;
  readonly task: Promise<OwnedTelegramSendResult>;
}

type OwnershipCommitOutcome =
  | { readonly kind: 'committed'; readonly state: 'owned' | 'complete' }
  | {
      readonly kind: 'rejected';
      readonly code: string;
      readonly state: OwnedTelegramOutboundState | undefined;
    };

export class OwnedTelegramSender {
  readonly name = 'telegram_outbound_ownership';

  private readonly inFlight = new Map<string, InFlightSend>();
  private readonly now: () => number;
  private readonly retryDelayMs: number;
  private readonly wait: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: OwnedTelegramSenderOptions) {
    this.now = options.now ?? Date.now;
    this.retryDelayMs = Math.max(0, Math.trunc(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS));
    this.wait = options.wait ?? defaultWait;
  }

  async send(input: OwnedTelegramSendInput, signal = new AbortController().signal): Promise<OwnedTelegramSendResult> {
    const current = this.inFlight.get(input.logicalKey);
    if (current !== undefined) {
      return sameIdentity(current.identity, input)
        ? current.task
        : this.skipped(null, null, 'logical_key_conflict');
    }

    const task = this.execute(input, signal);
    const inFlight: InFlightSend = { identity: input, task };
    this.inFlight.set(input.logicalKey, inFlight);
    try {
      return await task;
    } finally {
      if (this.inFlight.get(input.logicalKey) === inFlight) this.inFlight.delete(input.logicalKey);
    }
  }

  async drain(signal: AbortSignal): Promise<OwnedTelegramDrainResult> {
    for (;;) {
      if (signal.aborted) return { kind: 'timeout', unfinished: this.unfinished() };
      const tasks = [...this.inFlight.values()].map(({ task }) => task);
      if (tasks.length === 0) return { kind: 'drained' };
      if (!(await waitForTasks(tasks, signal))) {
        return { kind: 'timeout', unfinished: this.unfinished() };
      }
    }
  }

  unfinished(): number {
    return this.inFlight.size;
  }

  private async execute(input: OwnedTelegramSendInput, signal: AbortSignal): Promise<OwnedTelegramSendResult> {
    const planned = await this.attempt(() => this.options.db.planOutbound(input));
    if (planned === null) return this.skipped(null, null, 'outbound_plan_unavailable');
    if (!planned.ok) return this.skipped(null, null, planned.code);
    if (!sameIdentity(input, planned)) return this.skipped(planned.id, planned.state, 'logical_key_conflict');

    if (planned.state === 'owned' || planned.state === 'reconciled' || planned.state === 'complete') {
      return this.existingOutcome(planned.id, planned.state, planned.messageId);
    }
    if (planned.state !== 'planned') return this.skipped(planned.id, planned.state, 'outbound_not_planned');

    const started = await this.attempt(() =>
      this.options.db.startOutbound(planned.id, this.options.workerId, this.options.leaseMs),
    );
    if (started === null) return this.skipped(planned.id, 'planned', 'outbound_start_unavailable');
    if (!started.ok) return this.skipped(planned.id, started.state ?? 'planned', started.code);
    if (!sameIdentity(input, started)) return this.skipped(started.id, started.state, 'logical_key_conflict');

    const deadline = Date.parse(started.leaseExpiresAt);
    if (!Number.isFinite(deadline) || this.now() >= deadline) {
      return this.persistUncertainty(started.id, null, 'outbound_lease_expired', deadline);
    }

    const sent = await this.attempt(() => input.send(signal));
    if (sent === null) return this.persistUncertainty(started.id, null, 'telegram_send_ambiguous', deadline);
    if (!isTelegramMessageId(sent)) {
      return this.persistUncertainty(started.id, null, 'telegram_message_id_invalid', deadline);
    }

    const recordAuthoritativeMessageId = input.recordAuthoritativeMessageId;
    if (recordAuthoritativeMessageId !== undefined) {
      const recorded = await this.retryWithinLease(deadline, async () => {
        const result = await this.attempt(() => recordAuthoritativeMessageId(sent));
        return result === null ? null : 'recorded';
      });
      if (recorded === null) {
        return this.persistUncertainty(started.id, sent, 'authoritative_message_id_unconfirmed', deadline);
      }
    }

    const ownership = await this.retryWithinLease<OwnershipCommitOutcome>(deadline, async () => {
      const result = await this.attempt(() =>
        this.options.db.markOutboundOwned(started.id, this.options.workerId, sent),
      );
      if (result === null) return null;
      if (!result.ok) return { kind: 'rejected', code: result.code, state: result.state };
      return result.state === 'owned' || result.state === 'complete'
        ? { kind: 'committed', state: result.state }
        : { kind: 'rejected', code: 'outbound_ownership_state_invalid', state: result.state };
    });
    if (ownership === null) {
      return this.persistUncertainty(started.id, sent, 'ownership_commit_unconfirmed', deadline);
    }
    if (ownership.kind === 'committed') {
      return ownership.state === 'complete'
        ? { kind: 'complete', jobId: started.id, messageId: sent }
        : { kind: 'owned', jobId: started.id, messageId: sent, state: ownership.state };
    }
    if (ownership.code === 'ownership_conflict') {
      return this.persistUncertainty(started.id, sent, 'ownership_conflict', deadline);
    }
    return this.skipped(started.id, ownership.state ?? 'sending', ownership.code);
  }

  private existingOutcome(
    jobId: string,
    state: Extract<OwnedTelegramOutboundState, 'owned' | 'reconciled' | 'complete'>,
    messageId: number | null,
  ): OwnedTelegramSendResult {
    if (state === 'owned' || state === 'reconciled') {
      return isTelegramMessageId(messageId)
        ? { kind: 'owned', jobId, messageId, state }
        : this.skipped(jobId, state, 'outbound_message_id_missing');
    }
    return outcomeFromDurableState(jobId, messageId, state) ?? this.skipped(jobId, state, 'outbound_message_id_missing');
  }

  private async persistUncertainty(
    jobId: string,
    messageId: number | null,
    errorCode: string,
    deadline: number,
  ): Promise<OwnedTelegramSendResult> {
    const outcome = await this.retryWithinLease(deadline, async () => {
      const result = await this.attempt(() =>
        this.options.db.markOutboundUncertain(jobId, this.options.workerId, errorCode),
      );
      return result === null ? null : outcomeFromDurableState(jobId, messageId, result.state);
    });
    return outcome ?? this.skipped(jobId, 'sending', 'outbound_lease_expired');
  }

  private async retryWithinLease<T>(deadline: number, operation: () => Promise<T | null>): Promise<T | null> {
    for (;;) {
      if (!Number.isFinite(deadline) || this.now() >= deadline) return null;
      const result = await operation();
      if (result !== null) return result;
      const remaining = deadline - this.now();
      if (remaining <= 0) return null;
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

  private skipped(
    jobId: string | null,
    state: OwnedTelegramOutboundState | null,
    code: string,
  ): OwnedTelegramSendResult {
    return { kind: 'skipped', jobId, state, code };
  }
}

function sameIdentity(first: OwnedTelegramOutboundIdentity, second: OwnedTelegramOutboundIdentity): boolean {
  return (
    first.chatId === second.chatId &&
    first.domainKind === second.domainKind &&
    first.domainId === second.domainId
  );
}

function waitForTasks(tasks: readonly Promise<unknown>[], signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (drained: boolean) => {
      if (resolved) return;
      resolved = true;
      signal.removeEventListener('abort', onAbort);
      resolve(drained);
    };
    const onAbort = () => finish(false);
    signal.addEventListener('abort', onAbort, { once: true });
    void Promise.allSettled(tasks).then(() => finish(true));
  });
}
