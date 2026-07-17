export const ESCROW_RELAYER_JOB_KINDS = [
  'market_initialization',
  'freeze',
  'unfreeze',
  'position_activation',
  'settlement_submission',
  'timeout_monitoring',
  'auto_claim',
  'account_close',
] as const;

export type EscrowRelayerJobKind = (typeof ESCROW_RELAYER_JOB_KINDS)[number];

interface MarketJobIdentity {
  readonly programId: string;
  readonly marketPda: string;
}

export type EscrowRelayerJobIdentity =
  | (MarketJobIdentity & { readonly kind: 'market_initialization' })
  | (MarketJobIdentity & { readonly kind: 'freeze'; readonly eventEpoch: bigint })
  | (MarketJobIdentity & { readonly kind: 'unfreeze'; readonly eventEpoch: bigint })
  | (MarketJobIdentity & {
      readonly kind: 'position_activation';
      readonly owner: string;
      readonly lotNonce: bigint;
      readonly eventEpoch: bigint;
    })
  | (MarketJobIdentity & {
      readonly kind: 'settlement_submission';
      readonly oracleEpoch: bigint;
      readonly outcome: 'back' | 'doubt' | 'void';
      readonly evidenceHash: string;
    })
  | (MarketJobIdentity & {
      readonly kind: 'timeout_monitoring';
      readonly resolutionDeadlineUnix: bigint;
    })
  | (MarketJobIdentity & { readonly kind: 'auto_claim'; readonly owner: string })
  | (MarketJobIdentity & { readonly kind: 'account_close' });

export type EscrowRelayerJobStatus =
  | 'pending'
  | 'leased'
  | 'broadcast'
  | 'retry_wait'
  | 'confirmed'
  | 'dead_letter';

export interface EscrowPreparedTransaction {
  readonly rawTransactionBase64: string;
  readonly expectedSignature: string;
  readonly lastValidBlockHeight: bigint;
}

export interface EscrowJobLease {
  readonly workerId: string;
  readonly leaseToken: string;
}

export interface EscrowJobConfirmation {
  readonly signature: string;
  readonly slot: bigint;
}

export interface EscrowRelayerJob {
  readonly kind: EscrowRelayerJobKind;
  readonly idempotencyKey: string;
  readonly status: EscrowRelayerJobStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly lease: EscrowJobLease | null;
  readonly transaction: EscrowPreparedTransaction | null;
  readonly confirmation: EscrowJobConfirmation | null;
  readonly nextAttemptAtMs: number | null;
  readonly errorCode: string | null;
}

export type EscrowJobCommand =
  | {
      readonly type: 'lease';
      readonly workerId: string;
      readonly leaseToken: string;
      readonly nowMs: number;
    }
  | ({ readonly type: 'prepare_transaction' } & EscrowPreparedTransaction)
  | { readonly type: 'record_broadcast'; readonly observedSignature: string }
  | { readonly type: 'record_confirmation'; readonly signature: string; readonly slot: bigint }
  | {
      readonly type: 'schedule_rebroadcast';
      readonly currentBlockHeight: bigint;
      readonly nextAttemptAtMs: number;
      readonly errorCode: string;
    }
  | {
      readonly type: 'schedule_resign';
      readonly currentBlockHeight: bigint;
      readonly fullHistoryChecked: boolean;
      readonly transactionLanded: boolean;
      readonly nextAttemptAtMs: number;
      readonly errorCode: string;
    }
  | {
      readonly type: 'schedule_retry_without_transaction';
      readonly nextAttemptAtMs: number;
      readonly errorCode: string;
    }
  | { readonly type: 'dead_letter'; readonly errorCode: string };

export type EscrowJobTransitionError =
  | 'invalid_command'
  | 'invalid_state'
  | 'retry_not_due'
  | 'max_attempts_exhausted'
  | 'transaction_not_prepared'
  | 'transaction_already_prepared'
  | 'signature_mismatch'
  | 'blockhash_still_live'
  | 'blockhash_expired_requires_history_check'
  | 'full_history_check_required'
  | 'transaction_landed'
  | 'signed_transaction_must_be_reconciled';

export type EscrowJobTransitionResult =
  | { readonly ok: true; readonly changed: boolean; readonly job: EscrowRelayerJob }
  | { readonly ok: false; readonly code: EscrowJobTransitionError };

function invalid(code: EscrowJobTransitionError): EscrowJobTransitionResult {
  return { ok: false, code };
}

function changed(job: EscrowRelayerJob): EscrowJobTransitionResult {
  return { ok: true, changed: true, job };
}

function unchanged(job: EscrowRelayerJob): EscrowJobTransitionResult {
  return { ok: true, changed: false, job };
}

function assertNonEmpty(value: string, field: string): void {
  if (value.length === 0) throw new TypeError(`invalid escrow job ${field}`);
}

function assertNonNegativeBigint(value: bigint, field: string): void {
  if (value < 0n) throw new TypeError(`invalid escrow job ${field}`);
}

function canonicalSegment(value: string): string {
  assertNonEmpty(value, 'identity');
  if (!/^[\x21-\x7e]+$/.test(value)) throw new TypeError('invalid escrow job identity');
  return `${value.length}.${value}`;
}

function identitySegments(identity: EscrowRelayerJobIdentity): readonly string[] {
  const common = [identity.programId, identity.marketPda];
  switch (identity.kind) {
    case 'market_initialization':
    case 'account_close':
      return common;
    case 'freeze':
    case 'unfreeze':
      assertNonNegativeBigint(identity.eventEpoch, 'event epoch');
      return [...common, String(identity.eventEpoch)];
    case 'position_activation':
      assertNonNegativeBigint(identity.lotNonce, 'lot nonce');
      assertNonNegativeBigint(identity.eventEpoch, 'event epoch');
      return [...common, identity.owner, String(identity.lotNonce), String(identity.eventEpoch)];
    case 'settlement_submission':
      assertNonNegativeBigint(identity.oracleEpoch, 'oracle epoch');
      return [
        ...common,
        String(identity.oracleEpoch),
        identity.outcome,
        identity.evidenceHash,
      ];
    case 'timeout_monitoring':
      assertNonNegativeBigint(identity.resolutionDeadlineUnix, 'resolution deadline');
      return [...common, String(identity.resolutionDeadlineUnix)];
    case 'auto_claim':
      return [...common, identity.owner];
  }
}

export function createEscrowJobIdempotencyKey(identity: EscrowRelayerJobIdentity): string {
  return `escrow:v1:${identity.kind}:${identitySegments(identity).map(canonicalSegment).join(':')}`;
}

export function createEscrowJob(
  identity: EscrowRelayerJobIdentity,
  maxAttempts: number,
): EscrowRelayerJob {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new TypeError('invalid escrow job max attempts');
  }
  return {
    kind: identity.kind,
    idempotencyKey: createEscrowJobIdempotencyKey(identity),
    status: 'pending',
    attempts: 0,
    maxAttempts,
    lease: null,
    transaction: null,
    confirmation: null,
    nextAttemptAtMs: null,
    errorCode: null,
  };
}

function retryFields(command: {
  readonly nextAttemptAtMs: number;
  readonly errorCode: string;
}): Pick<EscrowRelayerJob, 'status' | 'lease' | 'nextAttemptAtMs' | 'errorCode'> | null {
  if (!Number.isSafeInteger(command.nextAttemptAtMs) || command.nextAttemptAtMs < 0) return null;
  if (command.errorCode.length === 0) return null;
  return {
    status: 'retry_wait',
    lease: null,
    nextAttemptAtMs: command.nextAttemptAtMs,
    errorCode: command.errorCode,
  };
}

function sameTransaction(
  transaction: EscrowPreparedTransaction,
  command: EscrowPreparedTransaction,
): boolean {
  return (
    transaction.rawTransactionBase64 === command.rawTransactionBase64 &&
    transaction.expectedSignature === command.expectedSignature &&
    transaction.lastValidBlockHeight === command.lastValidBlockHeight
  );
}

export function transitionEscrowJob(
  job: EscrowRelayerJob,
  command: EscrowJobCommand,
): EscrowJobTransitionResult {
  switch (command.type) {
    case 'lease': {
      if (
        !Number.isSafeInteger(command.nowMs) ||
        command.nowMs < 0 ||
        command.workerId.length === 0 ||
        command.leaseToken.length === 0
      ) {
        return invalid('invalid_command');
      }
      if (
        job.status === 'leased' &&
        job.lease?.workerId === command.workerId &&
        job.lease.leaseToken === command.leaseToken
      ) {
        return unchanged(job);
      }
      if (job.status !== 'pending' && job.status !== 'retry_wait') return invalid('invalid_state');
      if (job.nextAttemptAtMs !== null && command.nowMs < job.nextAttemptAtMs) {
        return invalid('retry_not_due');
      }
      if (job.attempts >= job.maxAttempts) return invalid('max_attempts_exhausted');
      return changed({
        ...job,
        status: 'leased',
        attempts: job.attempts + 1,
        lease: { workerId: command.workerId, leaseToken: command.leaseToken },
        nextAttemptAtMs: null,
        errorCode: null,
      });
    }
    case 'prepare_transaction': {
      if (job.status !== 'leased') return invalid('invalid_state');
      if (
        command.rawTransactionBase64.length === 0 ||
        command.expectedSignature.length === 0 ||
        command.lastValidBlockHeight < 0n
      ) {
        return invalid('invalid_command');
      }
      if (job.transaction !== null) {
        return sameTransaction(job.transaction, command)
          ? unchanged(job)
          : invalid('transaction_already_prepared');
      }
      return changed({
        ...job,
        transaction: {
          rawTransactionBase64: command.rawTransactionBase64,
          expectedSignature: command.expectedSignature,
          lastValidBlockHeight: command.lastValidBlockHeight,
        },
      });
    }
    case 'record_broadcast': {
      if (job.status !== 'leased' && job.status !== 'broadcast') return invalid('invalid_state');
      if (job.transaction === null) return invalid('transaction_not_prepared');
      if (command.observedSignature !== job.transaction.expectedSignature) {
        return invalid('signature_mismatch');
      }
      return job.status === 'broadcast'
        ? unchanged(job)
        : changed({ ...job, status: 'broadcast' });
    }
    case 'record_confirmation': {
      if (job.status === 'confirmed') {
        if (job.confirmation?.signature !== command.signature) return invalid('signature_mismatch');
        return job.confirmation.slot === command.slot ? unchanged(job) : invalid('invalid_command');
      }
      if (
        job.status !== 'leased' &&
        job.status !== 'broadcast' &&
        job.status !== 'retry_wait'
      ) {
        return invalid('invalid_state');
      }
      if (job.transaction === null) return invalid('transaction_not_prepared');
      if (command.signature !== job.transaction.expectedSignature) return invalid('signature_mismatch');
      if (command.slot < 0n) return invalid('invalid_command');
      return changed({
        ...job,
        status: 'confirmed',
        lease: null,
        confirmation: { signature: command.signature, slot: command.slot },
        nextAttemptAtMs: null,
        errorCode: null,
      });
    }
    case 'schedule_rebroadcast': {
      if (job.status !== 'leased' && job.status !== 'broadcast') return invalid('invalid_state');
      if (job.transaction === null) return invalid('transaction_not_prepared');
      if (command.currentBlockHeight < 0n) return invalid('invalid_command');
      if (command.currentBlockHeight > job.transaction.lastValidBlockHeight) {
        return invalid('blockhash_expired_requires_history_check');
      }
      const retry = retryFields(command);
      return retry === null ? invalid('invalid_command') : changed({ ...job, ...retry });
    }
    case 'schedule_resign': {
      if (
        job.status !== 'leased' &&
        job.status !== 'broadcast' &&
        job.status !== 'retry_wait'
      ) {
        return invalid('invalid_state');
      }
      if (job.transaction === null) return invalid('transaction_not_prepared');
      if (command.currentBlockHeight <= job.transaction.lastValidBlockHeight) {
        return invalid('blockhash_still_live');
      }
      if (!command.fullHistoryChecked) return invalid('full_history_check_required');
      if (command.transactionLanded) return invalid('transaction_landed');
      const retry = retryFields(command);
      return retry === null
        ? invalid('invalid_command')
        : changed({ ...job, ...retry, transaction: null });
    }
    case 'schedule_retry_without_transaction': {
      if (job.status !== 'leased') return invalid('invalid_state');
      if (job.transaction !== null) return invalid('signed_transaction_must_be_reconciled');
      const retry = retryFields(command);
      return retry === null ? invalid('invalid_command') : changed({ ...job, ...retry });
    }
    case 'dead_letter': {
      if (job.status === 'confirmed' || job.status === 'dead_letter') return invalid('invalid_state');
      if (command.errorCode.length === 0) return invalid('invalid_command');
      if (job.attempts < job.maxAttempts) return invalid('max_attempts_exhausted');
      return changed({
        ...job,
        status: 'dead_letter',
        lease: null,
        nextAttemptAtMs: null,
        errorCode: command.errorCode,
      });
    }
  }
}
