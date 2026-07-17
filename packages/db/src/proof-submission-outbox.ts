import { createClient } from '@supabase/supabase-js';
import { DbError, type PgResult } from './errors.js';
import {
  parseGetProofSubmission,
  parseProofSubmissionMutation,
  validatePrepareProofSubmission,
  validateProofSubmissionIdentity,
} from './proof-submission-outbox-parser.js';
import type {
  PrepareProofSubmissionInput,
  ProofSubmissionIdentity,
  ProofSubmissionOutboxDb,
} from './proof-submission-outbox-types.js';

export interface ProofSubmissionOutboxDbClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<PgResult<unknown>>;
}

export function createProofSubmissionOutboxDb(
  url: string,
  serviceRoleKey: string,
): ProofSubmissionOutboxDb {
  return proofSubmissionOutboxDbFromClient(
    createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } }),
  );
}

export function proofSubmissionOutboxDbFromClient(candidate: unknown): ProofSubmissionOutboxDb {
  const client = requireClient(candidate);
  return {
    get(marketId) {
      validateMarketId('proof_submission_get', marketId);
      return invoke(client, 'proof_submission_get', { p_market_id: marketId }, parseGetProofSubmission);
    },

    prepare(input) {
      validatePrepareProofSubmission(input);
      return invoke(client, 'proof_submission_prepare', {
        p_market_id: input.marketId,
        p_signature: input.signature,
        p_raw_tx_b64: input.rawTxB64,
        p_last_valid_block_height: input.lastValidBlockHeight,
        p_proof_payload: input.proofPayload,
        p_now: input.nowIso,
      }, parseProofSubmissionMutation);
    },

    markBroadcast(input) {
      return mutate(client, 'proof_submission_mark_broadcast', input);
    },

    markLanded(input) {
      return mutate(client, 'proof_submission_mark_landed', input);
    },

    markExpired(input) {
      return mutate(client, 'proof_submission_mark_expired', input);
    },
  } satisfies ProofSubmissionOutboxDb;
}

function mutate(
  client: ProofSubmissionOutboxDbClient,
  op: string,
  input: ProofSubmissionIdentity,
) {
  validateProofSubmissionIdentity(op, input);
  return invoke(client, op, {
    p_market_id: input.marketId,
    p_attempt: input.attempt,
    p_signature: input.signature,
    p_now: input.nowIso,
  }, parseProofSubmissionMutation);
}

async function invoke<T>(
  client: ProofSubmissionOutboxDbClient,
  op: string,
  args: Record<string, unknown>,
  parse: (op: string, payload: unknown) => T,
): Promise<T> {
  const result = await client.rpc(op, args);
  if (result.error !== null || result.data === null) {
    throw new DbError(op, result.error ?? { message: 'no RPC payload returned' });
  }
  return parse(op, result.data);
}

function requireClient(value: unknown): ProofSubmissionOutboxDbClient {
  if (isClient(value)) return value;
  throw new DbError('createProofSubmissionOutboxDb', { message: 'malformed Supabase client' });
}

function isClient(value: unknown): value is ProofSubmissionOutboxDbClient {
  return typeof value === 'object' && value !== null && 'rpc' in value && typeof value.rpc === 'function';
}

function validateMarketId(op: string, value: string): void {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return;
  throw new DbError(op, { message: 'invalid market id' });
}
