import { createClient } from '@supabase/supabase-js';
import { DbError, type PgResult } from './errors.js';
import {
  parseEnqueueSettlementProofJob,
  parseJobTransition,
  parseLeaseJobs,
  parseRecordProofState,
  parseRecordTerminalSettlement,
  parseReconcileTerminalJobs,
  parseSettlementPosted,
  parseSettlementProofBacklog,
  parseTerminalGaps,
} from './settlement-proof-job-parsers.js';
import type {
  CompleteSettlementProofJobInput,
  DeadLetterSettlementProofJobInput,
  EnqueueSettlementProofJobInput,
  JobTransitionResult,
  LeaseSettlementProofJobsInput,
  RecordProofStateInput,
  RecordProofStateResult,
  RecordTerminalSettlementInput,
  RecordTerminalSettlementResult,
  ReconcileTerminalJobsInput,
  RetrySettlementProofJobInput,
  SettlementPostedResult,
  SettlementProofBacklog,
  SettlementProofJobKind,
  SettlementProofJobRow,
  SettlementProofJobsDb,
  TerminalSettlementGap,
  ReconcileTerminalJobResult,
  EnqueueSettlementProofJobResult,
} from './settlement-proof-job-types.js';

export interface SettlementProofJobsDbClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<PgResult<unknown>>;
}

function isSettlementProofJobsDbClient(value: unknown): value is SettlementProofJobsDbClient {
  return typeof value === 'object' && value !== null && 'rpc' in value && typeof value.rpc === 'function';
}

export function createSettlementProofJobsDb(url: string, serviceRoleKey: string): SettlementProofJobsDb {
  const client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return settlementProofJobsDbFromClient(client);
}

export function settlementProofJobsDbFromClient(candidate: unknown): SettlementProofJobsDb {
  const client = requireSettlementProofJobsDbClient(candidate);
  return {
    recordTerminalSettlement(input) {
      validateTerminalSettlementInput(input);
      return invokeSettlementProofRpc(client, 'settlement_record_terminal', {
        p_market_id: input.marketId,
        p_outcome: input.outcome,
        p_deciding_seq: input.decidingSeq,
        p_evidence_seqs: input.evidenceSeqs,
        p_tier: input.tier,
        p_now: input.nowIso,
        p_max_attempts: input.maxAttempts,
        p_lease_ms: input.leaseMs,
        p_retry_base_ms: input.retryBaseMs,
        p_retry_max_ms: input.retryMaxMs,
      }, parseRecordTerminalSettlement);
    },

    markSettlementPosted(marketId, nowIso) {
      validateTimestamp('settlement_mark_posted', nowIso);
      return invokeSettlementProofRpc(client, 'settlement_mark_posted', {
        p_market_id: marketId,
        p_now: nowIso,
      }, parseSettlementPosted);
    },

    recordProofState(input) {
      validateProofInput(input);
      return invokeSettlementProofRpc(client, 'proof_record_state', {
        p_market_id: input.marketId,
        p_kind: input.kind,
        p_stat_key: input.statKey,
        p_seq: input.seq,
        p_merkle_proof: input.merkleProof,
        p_validate_stat_tx: input.validateStatTx,
        p_explorer_url: input.explorerUrl,
        p_status: input.status,
        p_now: input.nowIso,
      }, parseRecordProofState);
    },

    enqueueJob(input) {
      validateQueueInput('settlement_proof_enqueue', input);
      return invokeSettlementProofRpc(client, 'settlement_proof_enqueue', {
        p_market_id: input.marketId,
        p_job_kind: input.jobKind,
        p_due_at: input.dueAtIso,
        p_now: input.nowIso,
        p_max_attempts: input.maxAttempts,
        p_lease_ms: input.leaseMs,
        p_retry_base_ms: input.retryBaseMs,
        p_retry_max_ms: input.retryMaxMs,
      }, parseEnqueueSettlementProofJob);
    },

    leaseJobs(input) {
      validateTimestamp('settlement_proof_lease', input.nowIso);
      validateSafeInteger('settlement_proof_lease.limit', input.limit);
      return invokeSettlementProofRpc(client, 'settlement_proof_lease', {
        p_job_kind: input.jobKind,
        p_worker_id: input.workerId,
        p_now: input.nowIso,
        p_limit: input.limit,
      }, parseLeaseJobs);
    },

    completeJob(input) {
      validateTransitionInput('settlement_proof_complete', input);
      return invokeSettlementProofRpc(client, 'settlement_proof_complete', {
        p_market_id: input.marketId,
        p_job_kind: input.jobKind,
        p_worker_id: input.workerId,
        p_lease_token: input.leaseToken,
        p_now: input.nowIso,
      }, parseJobTransition);
    },

    retryJob(input) {
      validateTransitionInput('settlement_proof_retry', input);
      validateSafeInteger('settlement_proof_retry.delayMs', input.delayMs);
      return invokeSettlementProofRpc(client, 'settlement_proof_retry', {
        p_market_id: input.marketId,
        p_job_kind: input.jobKind,
        p_worker_id: input.workerId,
        p_lease_token: input.leaseToken,
        p_error_code: input.errorCode,
        p_delay_ms: input.delayMs,
        p_now: input.nowIso,
      }, parseJobTransition);
    },

    deadLetterJob(input) {
      validateTransitionInput('settlement_proof_dead_letter', input);
      return invokeSettlementProofRpc(client, 'settlement_proof_dead_letter', {
        p_market_id: input.marketId,
        p_job_kind: input.jobKind,
        p_worker_id: input.workerId,
        p_lease_token: input.leaseToken,
        p_error_code: input.errorCode,
        p_now: input.nowIso,
      }, parseJobTransition);
    },

    terminalGaps(limit) {
      validateSafeInteger('settlement_terminal_gaps.limit', limit);
      return invokeSettlementProofRpc(client, 'settlement_terminal_gaps', { p_limit: limit }, parseTerminalGaps);
    },

    reconcileTerminalJobs(input) {
      validateQueueInput('settlement_reconcile_terminal_jobs', input);
      validateSafeInteger('settlement_reconcile_terminal_jobs.limit', input.limit);
      validateSafeInteger('settlement_reconcile_terminal_jobs.initialChainProofDelayMs', input.initialChainProofDelayMs);
      return invokeSettlementProofRpc(client, 'settlement_reconcile_terminal_jobs', {
        p_now: input.nowIso,
        p_limit: input.limit,
        p_max_attempts: input.maxAttempts,
        p_lease_ms: input.leaseMs,
        p_retry_base_ms: input.retryBaseMs,
        p_retry_max_ms: input.retryMaxMs,
        p_initial_chain_proof_delay_ms: input.initialChainProofDelayMs,
      }, parseReconcileTerminalJobs);
    },

    backlog(kind, nowIso) {
      validateTimestamp('settlement_proof_backlog', nowIso);
      return invokeSettlementProofRpc(client, 'settlement_proof_backlog', {
        p_job_kind: kind,
        p_now: nowIso,
      }, parseSettlementProofBacklog);
    },
  } satisfies SettlementProofJobsDb;
}

export function requireSettlementProofJobsDbClient(value: unknown): SettlementProofJobsDbClient {
  if (isSettlementProofJobsDbClient(value)) {
    return value;
  }
  throw new DbError('createSettlementProofJobsDb', { message: 'malformed Supabase client' });
}

async function invokeSettlementProofRpc<T>(
  client: SettlementProofJobsDbClient,
  op: string,
  args: Record<string, unknown>,
  parse: (op: string, value: unknown) => T,
): Promise<T> {
  const result = await client.rpc(op, args);
  if (result.error !== null || result.data === null) {
    throw new DbError(op, result.error ?? { message: 'no RPC payload returned' });
  }
  return parse(op, result.data);
}

function validateTerminalSettlementInput(input: RecordTerminalSettlementInput): void {
  validateQueueInput('settlement_record_terminal', input);
  if (input.decidingSeq !== null) validateSafeInteger('settlement_record_terminal.decidingSeq', input.decidingSeq);
  for (const sequence of input.evidenceSeqs) {
    validateSafeInteger('settlement_record_terminal.evidenceSeqs', sequence);
  }
}

function validateProofInput(input: RecordProofStateInput): void {
  validateTimestamp('proof_record_state', input.nowIso);
  if (input.statKey !== null) validateSafeInteger('proof_record_state.statKey', input.statKey);
  if (input.seq !== null) validateSafeInteger('proof_record_state.seq', input.seq);
}

function validateQueueInput(
  op: string,
  input: {
    readonly nowIso: string;
    readonly maxAttempts: number;
    readonly leaseMs: number;
    readonly retryBaseMs: number;
    readonly retryMaxMs: number;
  },
): void {
  validateTimestamp(op, input.nowIso);
  validateSafeInteger(`${op}.maxAttempts`, input.maxAttempts);
  validateSafeInteger(`${op}.leaseMs`, input.leaseMs);
  validateSafeInteger(`${op}.retryBaseMs`, input.retryBaseMs);
  validateSafeInteger(`${op}.retryMaxMs`, input.retryMaxMs);
}

function validateTransitionInput(
  op: string,
  input: CompleteSettlementProofJobInput | RetrySettlementProofJobInput | DeadLetterSettlementProofJobInput,
): void {
  validateTimestamp(op, input.nowIso);
}

function validateTimestamp(op: string, value: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))
  ) {
    throw new DbError(op, { message: 'invalid injected timestamp' });
  }
}

function validateSafeInteger(op: string, value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new DbError(op, { message: 'unsafe integer' });
  }
}

export type {
  EnqueueSettlementProofJobResult,
  JobTransitionResult,
  RecordProofStateResult,
  RecordTerminalSettlementResult,
  ReconcileTerminalJobResult,
  SettlementPostedResult,
  SettlementProofBacklog,
  SettlementProofJobKind,
  SettlementProofJobRow,
  SettlementProofJobsDb,
  TerminalSettlementGap,
};
