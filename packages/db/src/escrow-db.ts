import { createClient } from '@supabase/supabase-js';
import { DbError, type PgResult } from './errors.js';
import { escrowReleaseBlockersDbFromClient } from './escrow-release-blockers-db.js';
import type {
  AdvanceEscrowChainCursorInput,
  ConsumeEscrowSigningSessionAndEnqueuePlacementInput,
  ConsumeEscrowSigningSessionAndEnqueuePlacementResult,
  ConsumeEscrowSigningSessionInput,
  DeadLetterEscrowRelayerJobInput,
  EscrowAsset,
  EscrowClaimEventInput,
  EscrowCluster,
  EscrowCommitment,
  EscrowDb,
  EscrowIndexResult,
  EscrowMarketLinkInput,
  EscrowPositionEventInput,
  EscrowPositionAccountInput,
  EscrowReconciliationStatus,
  EscrowReconciliationLink,
  EscrowRelayerBacklog,
  EscrowRelayerJobRow,
  EscrowRelayerJobState,
  EscrowRelayerMutationResult,
  EscrowSettlementEventInput,
  EscrowSigningSessionResult,
  LeaseEscrowRelayerJobsInput,
  ListEscrowReconciliationLinksInput,
  ListEscrowReconciliationLinksResult,
  MarkEscrowRelayerSubmittedInput,
  RecordEscrowReconciliationInput,
  RecordEscrowRelayerSignedTransactionInput,
  RetryEscrowRelayerJobInput,
  RewindEscrowConfirmedChainInput,
  RewindEscrowConfirmedChainResult,
  EscrowRelayerLeaseTransitionInput,
} from './escrow-types.js';
import type {
  CreateDurableEscrowSigningSessionInput,
  DurableEnqueueEscrowRelayerJobInput,
  DurableEscrowDb,
  DurableEscrowRelayerJobKind,
  DurableEscrowRelayerJobRow,
  EscrowSigningSessionAuthorizationPayload,
  GetEscrowChainCursorInput,
  GetEscrowChainCursorResult,
  GetEscrowMarketLinkInput,
  GetEscrowMarketLinkResult,
  GetEscrowSigningSessionInput,
  GetEscrowSigningSessionResult,
} from './types.js';

export interface EscrowDbClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<PgResult<unknown>>;
}

export function createEscrowDb(supabaseUrl: string, serviceRoleKey: string): DurableEscrowDb {
  return escrowDbFromClient(createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }));
}

export function escrowDbFromClient(value: unknown): DurableEscrowDb {
  const client = requireEscrowDbClient(value);
  return {
    ...escrowReleaseBlockersDbFromClient(client),
    upsertMarketLink(input) {
      validateMarketLink(input);
      return rpc(client, 'escrow_index_market_link', {
        p_market_id: input.marketId,
        p_custody_mode: input.custodyMode,
        p_custody_version: input.custodyVersion,
        p_cluster: input.cluster,
        p_genesis_hash: input.genesisHash,
        p_program_id: input.programId,
        p_market_pda: input.marketPda,
        p_vault_pda: input.vaultPda,
        p_asset: input.asset,
        p_mint_pubkey: input.mintPubkey,
        p_document_hash_hex: input.documentHashHex,
        p_initialize_signature: input.initializeSignature,
        p_initialize_instruction_index: input.initializeInstructionIndex,
        p_initialize_slot: decimal(input.initializeSlot, 'initializeSlot'),
        p_initialize_block_time: input.initializeBlockTimeIso,
        p_oracle_epoch: decimal(input.oracleEpoch, 'oracleEpoch'),
        p_event_epoch: decimal(input.eventEpoch, 'eventEpoch'),
        p_ratio_milli: decimal(input.ratioMilli, 'ratioMilli'),
        p_commitment: input.commitment,
        p_observed_at: input.observedAtIso,
      }, parseIndexResult);
    },

    getMarketLink(input) {
      validateGetMarketLink(input);
      return rpc(client, 'escrow_get_market_link', {
        p_cluster: input.cluster,
        p_genesis_hash: input.genesisHash,
        p_program_id: input.programId,
        p_market_pda: input.marketPda,
      }, (operation, value) => parseMarketLink(operation, value, input));
    },

    recordPositionEvent(input) {
      validatePositionEvent(input);
      return rpc(client, 'escrow_index_position_event', {
        p_signature: input.signature,
        p_instruction_index: input.instructionIndex,
        p_market_id: input.marketId,
        p_program_id: input.programId,
        p_position_pda: input.positionPda,
        p_owner_pubkey: input.ownerPubkey,
        p_lot_nonce: decimal(input.lotNonce, 'lotNonce'),
        p_event_kind: input.eventKind,
        p_side: input.side,
        p_asset: input.asset,
        p_amount_atomic: decimal(input.amountAtomic, 'amountAtomic', true),
        p_event_epoch: decimal(input.eventEpoch, 'eventEpoch'),
        p_state: input.state,
        p_slot: decimal(input.slot, 'slot'),
        p_block_time: input.blockTimeIso,
        p_commitment: input.commitment,
        p_observed_at: input.observedAtIso,
      }, parseIndexResult);
    },

    upsertPositionAccount(input) {
      validatePositionAccount(input);
      return rpc(client, 'escrow_index_position_account', {
        p_market_id: input.marketId,
        p_program_id: input.programId,
        p_owner_pubkey: input.ownerPubkey,
        p_position_pda: input.positionPda,
        p_side: input.side,
        p_asset: input.asset,
        p_deposited_atomic: decimal(input.depositedAtomic, 'depositedAtomic'),
        p_pending_atomic: decimal(input.pendingAtomic, 'pendingAtomic'),
        p_active_atomic: decimal(input.activeAtomic, 'activeAtomic'),
        p_refundable_atomic: decimal(input.refundableAtomic, 'refundableAtomic'),
        p_claimed_atomic: decimal(input.claimedAtomic, 'claimedAtomic'),
        p_next_lot_nonce: decimal(input.nextLotNonce, 'nextLotNonce'),
        p_source_slot: decimal(input.sourceSlot, 'sourceSlot'),
        p_commitment: input.commitment,
        p_observed_at: input.observedAtIso,
      }, parseIndexResult);
    },

    recordSettlementEvent(input) {
      validateSettlementEvent(input);
      return rpc(client, 'escrow_index_settlement_event', {
        p_signature: input.signature,
        p_instruction_index: input.instructionIndex,
        p_market_id: input.marketId,
        p_program_id: input.programId,
        p_outcome: input.outcome,
        p_evidence_hash_hex: input.evidenceHashHex,
        p_document_hash_hex: input.documentHashHex,
        p_oracle_epoch: decimal(input.oracleEpoch, 'oracleEpoch'),
        p_slot: decimal(input.slot, 'slot'),
        p_block_time: input.blockTimeIso,
        p_commitment: input.commitment,
        p_observed_at: input.observedAtIso,
      }, parseIndexResult);
    },

    recordClaimEvent(input) {
      validateClaimEvent(input);
      return rpc(client, 'escrow_index_claim_event', {
        p_signature: input.signature,
        p_instruction_index: input.instructionIndex,
        p_market_id: input.marketId,
        p_program_id: input.programId,
        p_owner_pubkey: input.ownerPubkey,
        p_destination_pubkey: input.destinationPubkey,
        p_asset: input.asset,
        p_amount_atomic: decimal(input.amountAtomic, 'amountAtomic', true),
        p_claim_kind: input.claimKind,
        p_slot: decimal(input.slot, 'slot'),
        p_block_time: input.blockTimeIso,
        p_commitment: input.commitment,
        p_observed_at: input.observedAtIso,
      }, parseIndexResult);
    },

    advanceChainCursor(input) {
      validateCursor(input);
      return rpc(client, 'escrow_advance_chain_cursor', {
        p_cluster: input.cluster,
        p_genesis_hash: input.genesisHash,
        p_program_id: input.programId,
        p_commitment: input.commitment,
        p_slot: decimal(input.slot, 'slot'),
        p_signature: input.signature,
        p_now: input.nowIso,
      }, parseIndexResult);
    },

    getChainCursor(input) {
      validateGetChainCursor(input);
      return rpc(client, 'escrow_get_chain_cursor', {
        p_cluster: input.cluster,
        p_genesis_hash: input.genesisHash,
        p_program_id: input.programId,
      }, (operation, value) => parseChainCursor(operation, value, input));
    },

    rewindConfirmedChain(input) {
      validateCluster(input.cluster, 'cluster');
      nonempty(input.programId, 'programId');
      timestamp(input.nowIso, 'nowIso');
      return rpc(client, 'escrow_rewind_confirmed_chain', {
        p_cluster: input.cluster,
        p_program_id: input.programId,
        p_rewind_slot: decimal(input.rewindSlot, 'rewindSlot'),
        p_now: input.nowIso,
      }, parseRewindResult);
    },

    recordReconciliation(input) {
      validateReconciliation(input);
      return rpc(client, 'escrow_record_reconciliation', {
        p_market_id: input.marketId,
        p_cluster: input.cluster,
        p_program_id: input.programId,
        p_checked_slot: decimal(input.checkedSlot, 'checkedSlot'),
        p_vault_balance_atomic: decimal(input.vaultBalanceAtomic, 'vaultBalanceAtomic'),
        p_liability_atomic: decimal(input.liabilityAtomic, 'liabilityAtomic'),
        p_position_account_count: input.positionAccountCount,
        p_status: input.status,
        p_details: input.details,
        p_checked_at: input.checkedAtIso,
      }, parseIndexResult);
    },

    createSigningSession(input) {
      validateCreateSigningSession(input);
      return rpc(client, 'escrow_create_signing_session', {
        p_token_hash_hex: input.tokenHashHex,
        p_user_id: input.userId,
        p_provider_user_id: input.providerUserId,
        p_provider_wallet_id: input.providerWalletId,
        p_owner_pubkey: input.ownerPubkey,
        p_market_id: input.marketId,
        p_side: input.side,
        p_asset: input.asset,
        p_amount_atomic: decimal(input.amountAtomic, 'amountAtomic', true),
        p_lot_nonce: decimal(input.lotNonce, 'lotNonce'),
        p_event_epoch: decimal(input.eventEpoch, 'eventEpoch'),
        p_document_hash_hex: input.documentHashHex,
        p_transaction_message_hash_hex: input.transactionMessageHashHex,
        p_raw_transaction_base64: input.rawTransactionBase64,
        p_authorization: input.authorization,
        p_expires_at: input.expiresAtIso,
        p_now: input.nowIso,
      }, parseSigningSessionResult);
    },

    getSigningSession(input) {
      validateGetSigningSession(input);
      return rpc(client, 'escrow_get_signing_session', {
        p_token_hash_hex: input.tokenHashHex,
        p_now: input.nowIso,
      }, parseGetSigningSessionResult);
    },

    consumeSigningSession(input) {
      validateConsumeSigningSession(input);
      return rpc(client, 'escrow_consume_signing_session', {
        p_token_hash_hex: input.tokenHashHex,
        p_user_id: input.userId,
        p_provider_user_id: input.providerUserId,
        p_provider_wallet_id: input.providerWalletId,
        p_owner_pubkey: input.ownerPubkey,
        p_market_id: input.marketId,
        p_transaction_message_hash_hex: input.transactionMessageHashHex,
        p_transaction_signature: input.transactionSignature,
        p_now: input.nowIso,
      }, parseSigningSessionResult);
    },

    consumeSigningSessionAndEnqueuePlacement(input) {
      validateConsumeAndEnqueuePlacement(input);
      return rpc(client, 'escrow_consume_signing_session_and_enqueue_placement', {
        p_token_hash_hex: input.tokenHashHex,
        p_user_id: input.userId,
        p_provider_user_id: input.providerUserId,
        p_provider_wallet_id: input.providerWalletId,
        p_owner_pubkey: input.ownerPubkey,
        p_market_id: input.marketId,
        p_transaction_message_hash_hex: input.transactionMessageHashHex,
        p_transaction_signature: input.transactionSignature,
        p_idempotency_key: input.idempotencyKey,
        p_cluster: input.cluster,
        p_program_id: input.programId,
        p_custody_mode: input.custodyMode,
        p_custody_version: input.custodyVersion,
        p_payload: input.payload,
        p_due_at: input.dueAtIso,
        p_max_attempts: input.maxAttempts,
        p_lease_ms: input.leaseMs ?? 60_000,
        p_now: input.nowIso,
      }, parseConsumeAndEnqueuePlacementResult);
    },

    listReconciliationLinks(input) {
      validateListReconciliationLinks(input);
      return rpc(client, 'escrow_list_reconciliation_links', {
        p_cluster: input.cluster,
        p_genesis_hash: input.genesisHash,
        p_program_id: input.programId,
        p_custody_version: input.custodyVersion,
        p_cursor: input.cursor,
        p_limit: input.limit,
      }, parseReconciliationLinks);
    },

    enqueueRelayerJob(input) {
      validateEnqueue(input);
      return rpc(client, 'escrow_relayer_enqueue', {
        p_kind: input.kind,
        p_idempotency_key: input.idempotencyKey,
        p_cluster: input.cluster,
        p_program_id: input.programId,
        p_custody_mode: input.custodyMode,
        p_custody_version: input.custodyVersion,
        p_market_id: input.marketId,
        p_owner_pubkey: input.ownerPubkey,
        p_payload: input.payload,
        p_due_at: input.dueAtIso,
        p_max_attempts: input.maxAttempts,
        p_lease_ms: input.leaseMs ?? 60_000,
        p_now: input.nowIso,
      }, parseRelayerMutation);
    },

    leaseRelayerJobs(input) {
      validateLease(input);
      return rpc(client, 'escrow_relayer_lease', {
        p_worker_id: input.workerId,
        p_now: input.nowIso,
        p_limit: input.limit,
      }, parseRelayerJobs);
    },

    recordRelayerSignedTransaction(input) {
      validateSigned(input);
      return rpc(client, 'escrow_relayer_record_signed', {
        ...leaseArgs(input),
        p_raw_transaction: input.rawTransactionBase64,
        p_expected_signature: input.expectedSignature,
        p_last_valid_block_height: decimal(input.lastValidBlockHeight, 'lastValidBlockHeight'),
        p_transaction_message_hash_hex: input.transactionMessageHashHex,
      }, parseRelayerMutation);
    },

    markRelayerSubmitted(input) {
      validateLeaseTransition(input);
      nonempty(input.expectedSignature, 'expectedSignature');
      return rpc(client, 'escrow_relayer_mark_submitted', {
        ...leaseArgs(input),
        p_expected_signature: input.expectedSignature,
      }, parseRelayerMutation);
    },

    retryRelayerJob(input) {
      validateLeaseTransition(input);
      nonempty(input.errorCode, 'errorCode');
      timestamp(input.retryAtIso, 'retryAtIso');
      if (input.fullHistoryCheckedAtIso !== undefined && input.fullHistoryCheckedAtIso !== null) {
        timestamp(input.fullHistoryCheckedAtIso, 'fullHistoryCheckedAtIso');
      }
      if (input.currentBlockHeight !== undefined && input.currentBlockHeight !== null) {
        decimal(input.currentBlockHeight, 'currentBlockHeight');
      }
      return rpc(client, 'escrow_relayer_retry', {
        ...leaseArgs(input),
        p_error_code: input.errorCode,
        p_retry_at: input.retryAtIso,
        p_confirmation_unknown: input.confirmationUnknown,
        p_full_history_checked_at: input.fullHistoryCheckedAtIso ?? null,
        p_current_block_height: input.currentBlockHeight === undefined || input.currentBlockHeight === null
          ? null
          : decimal(input.currentBlockHeight, 'currentBlockHeight'),
      }, parseRelayerMutation);
    },

    completeRelayerJob(input) {
      validateLeaseTransition(input);
      return rpc(client, 'escrow_relayer_complete', leaseArgs(input), parseRelayerMutation);
    },

    deadLetterRelayerJob(input) {
      validateLeaseTransition(input);
      nonempty(input.errorCode, 'errorCode');
      return rpc(client, 'escrow_relayer_dead_letter', {
        ...leaseArgs(input),
        p_error_code: input.errorCode,
      }, parseRelayerMutation);
    },

    relayerBacklog(nowIso) {
      timestamp(nowIso, 'nowIso');
      return rpc(client, 'escrow_relayer_backlog', { p_now: nowIso }, parseRelayerBacklog);
    },
  } satisfies DurableEscrowDb;
}

export function requireEscrowDbClient(value: unknown): EscrowDbClient {
  if (typeof value === 'object' && value !== null && 'rpc' in value && typeof value.rpc === 'function') {
    return value as EscrowDbClient;
  }
  throw new DbError('escrowDbFromClient', { message: 'malformed Supabase client' });
}

async function rpc<T>(
  client: EscrowDbClient,
  operation: string,
  args: Record<string, unknown>,
  parse: (operation: string, value: unknown) => T,
): Promise<T> {
  const result = await client.rpc(operation, args);
  if (result.error !== null || result.data === null) {
    throw new DbError(operation, result.error ?? { message: 'no RPC payload returned' });
  }
  return parse(operation, result.data);
}

type Row = Readonly<Record<string, unknown>>;

function row(operation: string, value: unknown): Row {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Row;
  return malformed(operation, '<row>');
}

function object(operation: string, value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Readonly<Record<string, unknown>>;
  }
  return malformed(operation, field);
}

function bool(operation: string, value: unknown, field: string): boolean {
  if (typeof value === 'boolean') return value;
  return malformed(operation, field);
}

function string(operation: string, value: unknown, field: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  return malformed(operation, field);
}

function nullableString(operation: string, value: unknown, field: string): string | null {
  if (value === null) return null;
  return string(operation, value, field);
}

function integer(operation: string, value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  return malformed(operation, field);
}

function bigintValue(operation: string, value: unknown, field: string): bigint {
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return malformed(operation, field);
}

function nullableBigint(operation: string, value: unknown, field: string): bigint | null {
  if (value === null) return null;
  return bigintValue(operation, value, field);
}

function parseIndexResult(operation: string, value: unknown): EscrowIndexResult {
  const valueRow = row(operation, value);
  if (valueRow.ok !== true) return malformed(operation, 'ok');
  return {
    ok: true,
    duplicate: bool(operation, valueRow.duplicate, 'duplicate'),
    finalized: bool(operation, valueRow.finalized, 'finalized'),
  };
}

function parseRewindResult(operation: string, value: unknown): RewindEscrowConfirmedChainResult {
  const valueRow = row(operation, value);
  if (valueRow.ok !== true) return malformed(operation, 'ok');
  return {
    ok: true,
    orphanedEvents: integer(operation, valueRow.orphaned_events, 'orphaned_events'),
    rewindSlot: bigintValue(operation, valueRow.rewind_slot, 'rewind_slot'),
  };
}

function parseChainCursor(
  operation: string,
  value: unknown,
  expected: GetEscrowChainCursorInput,
): GetEscrowChainCursorResult {
  const valueRow = row(operation, value);
  if (valueRow.ok === false) {
    if (valueRow.code === 'invalid_input' || valueRow.code === 'genesis_mismatch') {
      return { ok: false, code: valueRow.code };
    }
    return malformed(operation, 'code');
  }
  if (valueRow.ok !== true) return malformed(operation, 'ok');
  const initialized = bool(operation, valueRow.initialized, 'initialized');
  const actualCluster = cluster(operation, valueRow.cluster);
  const actualGenesisHash = boundedStringValue(operation, valueRow.genesis_hash, 'genesis_hash');
  const actualProgramId = boundedStringValue(operation, valueRow.program_id, 'program_id');
  const confirmedSlot = bigintValue(operation, valueRow.last_confirmed_slot, 'last_confirmed_slot');
  const confirmedSignature = nullableString(
    operation,
    valueRow.last_confirmed_signature,
    'last_confirmed_signature',
  );
  const finalizedSlot = bigintValue(operation, valueRow.last_finalized_slot, 'last_finalized_slot');
  const finalizedSignature = nullableString(
    operation,
    valueRow.last_finalized_signature,
    'last_finalized_signature',
  );
  const updatedAtIso = nullableTimestamp(operation, valueRow.updated_at, 'updated_at');
  if (
    actualCluster !== expected.cluster
    || actualGenesisHash !== expected.genesisHash
    || actualProgramId !== expected.programId
    || finalizedSlot > confirmedSlot
    || (confirmedSlot > 0n && confirmedSignature === null)
    || (finalizedSlot > 0n && finalizedSignature === null)
    || (initialized && updatedAtIso === null)
    || (!initialized && (
      confirmedSlot !== 0n
      || confirmedSignature !== null
      || finalizedSlot !== 0n
      || finalizedSignature !== null
      || updatedAtIso !== null
    ))
  ) return malformed(operation, 'cursor_binding');
  return {
    ok: true,
    initialized,
    cluster: actualCluster,
    genesisHash: actualGenesisHash,
    programId: actualProgramId,
    confirmedSlot,
    confirmedSignature,
    finalizedSlot,
    finalizedSignature,
    updatedAtIso,
  };
}

function parseMarketLink(
  operation: string,
  value: unknown,
  expected: GetEscrowMarketLinkInput,
): GetEscrowMarketLinkResult {
  const valueRow = row(operation, value);
  if (valueRow.ok === false) {
    switch (valueRow.code) {
      case 'invalid_input':
      case 'identity_mismatch':
      case 'ambiguous':
      case 'noncanonical':
      case 'custody_mismatch':
        return { ok: false, code: valueRow.code };
      default:
        return malformed(operation, 'code');
    }
  }
  if (valueRow.ok !== true) return malformed(operation, 'ok');
  const found = bool(operation, valueRow.found, 'found');
  if (!found) return { ok: true, found: false };
  const actualCluster = cluster(operation, valueRow.cluster);
  const actualGenesisHash = boundedStringValue(operation, valueRow.genesis_hash, 'genesis_hash');
  const actualProgramId = boundedStringValue(operation, valueRow.program_id, 'program_id');
  const actualMarketPda = boundedStringValue(operation, valueRow.market_pda, 'market_pda');
  const custodyVersion = integer(operation, valueRow.custody_version, 'custody_version');
  const canonical = bool(operation, valueRow.canonical, 'canonical');
  const asset = signingAsset(operation, valueRow.asset);
  const mintPubkey = nullableString(operation, valueRow.mint_pubkey, 'mint_pubkey');
  const ratioMilli = bigintValue(operation, valueRow.ratio_milli, 'ratio_milli');
  if (
    actualCluster !== expected.cluster
    || actualGenesisHash !== expected.genesisHash
    || actualProgramId !== expected.programId
    || actualMarketPda !== expected.marketPda
    || valueRow.custody_mode !== 'escrow'
    || valueRow.market_custody_mode !== 'escrow'
    || custodyVersion < 1
    || !canonical
    || (asset === 'sol' && mintPubkey !== null)
    || (asset === 'usdc' && mintPubkey === null)
    || ratioMilli < 1n
  ) return malformed(operation, 'market_binding');
  return {
    ok: true,
    found: true,
    marketId: uuid(operation, valueRow.market_id, 'market_id'),
    custodyMode: 'escrow',
    custodyVersion,
    cluster: actualCluster,
    genesisHash: actualGenesisHash,
    programId: actualProgramId,
    marketPda: actualMarketPda,
    vaultPda: boundedStringValue(operation, valueRow.vault_pda, 'vault_pda'),
    asset,
    mintPubkey,
    documentHashHex: hashValue(operation, valueRow.document_hash_hex, 'document_hash_hex'),
    oracleEpoch: bigintValue(operation, valueRow.oracle_epoch, 'oracle_epoch'),
    eventEpoch: bigintValue(operation, valueRow.event_epoch, 'event_epoch'),
    ratioMilli,
    chainState: marketChainState(operation, valueRow.chain_state),
    commitment: commitmentValue(operation, valueRow.commitment),
    projectionStale: bool(operation, valueRow.projection_stale, 'projection_stale'),
  };
}

function parseSigningSessionResult(operation: string, value: unknown): EscrowSigningSessionResult {
  const valueRow = row(operation, value);
  if (valueRow.ok === true) {
    if ('created' in valueRow) {
      return { ok: true, created: bool(operation, valueRow.created, 'created') };
    }
    if (valueRow.state === 'consumed') {
      return {
        ok: true,
        duplicate: bool(operation, valueRow.duplicate, 'duplicate'),
        state: 'consumed',
      };
    }
    return malformed(operation, 'state');
  }
  if (valueRow.ok === false) {
    switch (valueRow.code) {
      case 'invalid_input':
      case 'session_not_found':
      case 'session_expired':
      case 'session_consumed':
      case 'binding_mismatch':
        return { ok: false, code: valueRow.code };
      default:
        return malformed(operation, 'code');
    }
  }
  return malformed(operation, 'ok');
}

function parseConsumeAndEnqueuePlacementResult(
  operation: string,
  value: unknown,
): ConsumeEscrowSigningSessionAndEnqueuePlacementResult {
  const valueRow = row(operation, value);
  if (valueRow.ok === true) {
    if (valueRow.state !== 'consumed') return malformed(operation, 'state');
    return {
      ok: true,
      duplicate: bool(operation, valueRow.duplicate, 'duplicate'),
      state: 'consumed',
      jobCreated: bool(operation, valueRow.job_created, 'job_created'),
      jobId: uuid(operation, valueRow.job_id, 'job_id'),
    };
  }
  if (valueRow.ok === false) {
    switch (valueRow.code) {
      case 'invalid_input':
      case 'session_not_found':
      case 'session_expired':
      case 'session_consumed':
      case 'binding_mismatch':
        return { ok: false, code: valueRow.code };
      default:
        return malformed(operation, 'code');
    }
  }
  return malformed(operation, 'ok');
}

function parseReconciliationLinks(operation: string, value: unknown): ListEscrowReconciliationLinksResult {
  const valueRow = row(operation, value);
  if (!Array.isArray(valueRow.links)) return malformed(operation, 'links');
  const nextCursor = nullableUuid(operation, valueRow.next_cursor, 'next_cursor');
  return {
    links: valueRow.links.map((entry) => parseReconciliationLink(operation, entry)),
    nextCursor,
  };
}

function parseReconciliationLink(operation: string, value: unknown): EscrowReconciliationLink {
  const valueRow = row(operation, value);
  return {
    marketId: uuid(operation, valueRow.market_id, 'market_id'),
    custodyMode: escrowCustodyMode(operation, valueRow.custody_mode),
    marketPda: boundedStringValue(operation, valueRow.market_pda, 'market_pda'),
    vaultPda: boundedStringValue(operation, valueRow.vault_pda, 'vault_pda'),
    asset: signingAsset(operation, valueRow.asset),
    revalidationRequired: bool(operation, valueRow.revalidation_required, 'revalidation_required'),
  };
}

function parseGetSigningSessionResult(operation: string, value: unknown): GetEscrowSigningSessionResult {
  const valueRow = row(operation, value);
  if (valueRow.ok === false) {
    switch (valueRow.code) {
      case 'invalid_input':
      case 'session_not_found':
      case 'session_expired':
      case 'session_consumed':
        return { ok: false, code: valueRow.code };
      default:
        return malformed(operation, 'code');
    }
  }
  if (valueRow.ok !== true) return malformed(operation, 'ok');
  if (valueRow.state !== 'pending' && valueRow.state !== 'consumed') {
    return malformed(operation, 'state');
  }
  return {
    ok: true,
    state: valueRow.state,
    userId: integer(operation, valueRow.user_id, 'user_id'),
    providerUserId: string(operation, valueRow.provider_user_id, 'provider_user_id'),
    providerWalletId: string(operation, valueRow.provider_wallet_id, 'provider_wallet_id'),
    ownerPubkey: string(operation, valueRow.owner_pubkey, 'owner_pubkey'),
    marketId: uuid(operation, valueRow.market_id, 'market_id'),
    side: signingSide(operation, valueRow.side),
    asset: signingAsset(operation, valueRow.asset),
    amountAtomic: bigintValue(operation, valueRow.amount_atomic, 'amount_atomic'),
    lotNonce: bigintValue(operation, valueRow.lot_nonce, 'lot_nonce'),
    eventEpoch: bigintValue(operation, valueRow.event_epoch, 'event_epoch'),
    documentHashHex: hashValue(operation, valueRow.document_hash_hex, 'document_hash_hex'),
    transactionMessageHashHex: hashValue(
      operation,
      valueRow.transaction_message_hash_hex,
      'transaction_message_hash_hex',
    ),
    rawTransactionBase64: base64Value(operation, valueRow.raw_transaction_base64, 'raw_transaction_base64'),
    authorization: authorizationValue(operation, valueRow.authorization),
    transactionSignature: nullableString(operation, valueRow.transaction_signature, 'transaction_signature'),
    expiresAtIso: parsedTimestamp(operation, valueRow.expires_at, 'expires_at'),
  };
}

function parseRelayerMutation(operation: string, value: unknown): EscrowRelayerMutationResult {
  const valueRow = row(operation, value);
  if (valueRow.ok === true && 'created' in valueRow) {
    return {
      ok: true,
      created: bool(operation, valueRow.created, 'created'),
      jobId: uuid(operation, valueRow.job_id, 'job_id'),
    };
  }
  if (valueRow.ok === true) {
    return {
      ok: true,
      duplicate: bool(operation, valueRow.duplicate, 'duplicate'),
      state: relayerState(operation, valueRow.state),
    };
  }
  if (valueRow.ok === false) {
    switch (valueRow.code) {
      case 'job_not_found':
      case 'lease_lost':
      case 'state_conflict':
      case 'signature_mismatch':
        return { ok: false, code: valueRow.code };
      default:
        return malformed(operation, 'code');
    }
  }
  return malformed(operation, 'ok');
}

function parseRelayerJobs(operation: string, value: unknown): readonly DurableEscrowRelayerJobRow[] {
  if (!Array.isArray(value)) return malformed(operation, '<rows>');
  return value.map((item) => {
    const valueRow = row(operation, item);
    return {
      id: uuid(operation, valueRow.id, 'id'),
      kind: relayerKind(operation, valueRow.kind),
      idempotencyKey: string(operation, valueRow.idempotency_key, 'idempotency_key'),
      state: relayerState(operation, valueRow.state),
      cluster: cluster(operation, valueRow.cluster),
      programId: string(operation, valueRow.program_id, 'program_id'),
      custodyMode: escrowCustodyMode(operation, valueRow.custody_mode),
      custodyVersion: integer(operation, valueRow.custody_version, 'custody_version'),
      marketId: nullableUuid(operation, valueRow.market_id, 'market_id'),
      ownerPubkey: nullableString(operation, valueRow.owner_pubkey, 'owner_pubkey'),
      payload: object(operation, valueRow.payload, 'payload'),
      attempts: integer(operation, valueRow.attempts, 'attempts'),
      maxAttempts: integer(operation, valueRow.max_attempts, 'max_attempts'),
      leaseDurationMs: integer(operation, valueRow.lease_duration_ms, 'lease_duration_ms'),
      dueAt: parsedTimestamp(operation, valueRow.due_at, 'due_at'),
      leaseOwner: nullableString(operation, valueRow.lease_owner, 'lease_owner'),
      leaseToken: nullableUuid(operation, valueRow.lease_token, 'lease_token'),
      leaseExpiresAt: nullableTimestamp(operation, valueRow.lease_expires_at, 'lease_expires_at'),
      expectedSignature: nullableString(operation, valueRow.expected_signature, 'expected_signature'),
      rawTransactionBase64: nullableString(operation, valueRow.raw_transaction, 'raw_transaction'),
      transactionMessageHashHex: nullableString(operation, valueRow.transaction_message_hash_hex, 'transaction_message_hash_hex'),
      lastValidBlockHeight: nullableBigint(operation, valueRow.last_valid_block_height, 'last_valid_block_height'),
      errorCode: nullableString(operation, valueRow.error_code, 'error_code'),
      createdAt: parsedTimestamp(operation, valueRow.created_at, 'created_at'),
      updatedAt: parsedTimestamp(operation, valueRow.updated_at, 'updated_at'),
    };
  });
}

function parseRelayerBacklog(operation: string, value: unknown): EscrowRelayerBacklog {
  const valueRow = row(operation, value);
  const age = valueRow.oldest_ready_age_ms;
  return {
    readyCount: integer(operation, valueRow.ready_count, 'ready_count'),
    leasedCount: integer(operation, valueRow.leased_count, 'leased_count'),
    unknownCount: integer(operation, valueRow.unknown_count, 'unknown_count'),
    submittedCount: integer(operation, valueRow.submitted_count, 'submitted_count'),
    deadCount: integer(operation, valueRow.dead_count, 'dead_count'),
    oldestReadyAgeMs: age === null ? null : integer(operation, age, 'oldest_ready_age_ms'),
  };
}

function malformed(operation: string, field: string): never {
  throw new DbError(operation, { message: `malformed RPC payload field: ${field}` });
}

function uuid(operation: string, value: unknown, field: string): string {
  const parsed = string(operation, value, field);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed)) return parsed;
  return malformed(operation, field);
}

function nullableUuid(operation: string, value: unknown, field: string): string | null {
  if (value === null) return null;
  return uuid(operation, value, field);
}

function cluster(operation: string, value: unknown): EscrowCluster {
  switch (value) {
    case 'localnet':
    case 'devnet':
    case 'mainnet-beta':
      return value;
    default:
      return malformed(operation, 'cluster');
  }
}

function relayerKind(operation: string, value: unknown): DurableEscrowRelayerJobKind {
  switch (value) {
    case 'market_initialization':
    case 'freeze':
    case 'unfreeze':
    case 'position_placement':
    case 'position_activation':
    case 'position_invalidation':
    case 'settlement_submission':
    case 'timeout_monitoring':
    case 'auto_claim':
    case 'account_close':
      return value;
    default:
      return malformed(operation, 'kind');
  }
}

function marketChainState(
  operation: string,
  value: unknown,
): 'open' | 'frozen' | 'settled' | 'voided' | 'closed' {
  switch (value) {
    case 'open':
    case 'frozen':
    case 'settled':
    case 'voided':
    case 'closed':
      return value;
    default:
      return malformed(operation, 'chain_state');
  }
}

function commitmentValue(operation: string, value: unknown): EscrowCommitment {
  if (value === 'confirmed' || value === 'finalized') return value;
  return malformed(operation, 'commitment');
}

function relayerState(operation: string, value: unknown): EscrowRelayerJobState {
  switch (value) {
    case 'pending':
    case 'leased':
    case 'signed':
    case 'submitted':
    case 'unknown':
    case 'retry_wait':
    case 'complete':
    case 'dead':
      return value;
    default:
      return malformed(operation, 'state');
  }
}

function parsedTimestamp(operation: string, value: unknown, field: string): string {
  const parsed = string(operation, value, field);
  if (isTimestamp(parsed)) return parsed;
  return malformed(operation, field);
}

function nullableTimestamp(operation: string, value: unknown, field: string): string | null {
  if (value === null) return null;
  return parsedTimestamp(operation, value, field);
}

function validateMarketLink(input: EscrowMarketLinkInput): void {
  uuidInput(input.marketId, 'marketId');
  if (input.custodyMode !== 'escrow') invalid('custodyMode');
  safeInteger(input.custodyVersion, 'custodyVersion', true);
  validateCluster(input.cluster, 'cluster');
  nonempty(input.genesisHash, 'genesisHash');
  nonempty(input.programId, 'programId');
  nonempty(input.marketPda, 'marketPda');
  nonempty(input.vaultPda, 'vaultPda');
  validateAsset(input.asset, 'asset');
  if (input.asset === 'sol' && input.mintPubkey !== null) invalid('mintPubkey');
  if (input.asset === 'usdc') nonempty(input.mintPubkey, 'mintPubkey');
  hash(input.documentHashHex, 'documentHashHex');
  nonempty(input.initializeSignature, 'initializeSignature');
  safeInteger(input.initializeInstructionIndex, 'initializeInstructionIndex');
  decimal(input.initializeSlot, 'initializeSlot');
  optionalTimestamp(input.initializeBlockTimeIso, 'initializeBlockTimeIso');
  decimal(input.oracleEpoch, 'oracleEpoch');
  decimal(input.eventEpoch, 'eventEpoch');
  decimal(input.ratioMilli, 'ratioMilli', true);
  validateCommitment(input.commitment, 'commitment');
  timestamp(input.observedAtIso, 'observedAtIso');
}

function validateGetMarketLink(input: GetEscrowMarketLinkInput): void {
  validateCluster(input.cluster, 'cluster');
  boundedNonempty(input.genesisHash, 'genesisHash');
  boundedNonempty(input.programId, 'programId');
  boundedNonempty(input.marketPda, 'marketPda');
}

function validatePositionEvent(input: EscrowPositionEventInput): void {
  chainIdentity(input.signature, input.instructionIndex);
  uuidInput(input.marketId, 'marketId');
  nonempty(input.programId, 'programId');
  nonempty(input.positionPda, 'positionPda');
  nonempty(input.ownerPubkey, 'ownerPubkey');
  decimal(input.lotNonce, 'lotNonce');
  validateAsset(input.asset, 'asset');
  decimal(input.amountAtomic, 'amountAtomic', true);
  decimal(input.eventEpoch, 'eventEpoch');
  decimal(input.slot, 'slot');
  optionalTimestamp(input.blockTimeIso, 'blockTimeIso');
  validateCommitment(input.commitment, 'commitment');
  timestamp(input.observedAtIso, 'observedAtIso');
}

function validatePositionAccount(input: EscrowPositionAccountInput): void {
  uuidInput(input.marketId, 'marketId');
  nonempty(input.programId, 'programId');
  nonempty(input.ownerPubkey, 'ownerPubkey');
  nonempty(input.positionPda, 'positionPda');
  validateAsset(input.asset, 'asset');
  decimal(input.depositedAtomic, 'depositedAtomic');
  decimal(input.pendingAtomic, 'pendingAtomic');
  decimal(input.activeAtomic, 'activeAtomic');
  decimal(input.refundableAtomic, 'refundableAtomic');
  decimal(input.claimedAtomic, 'claimedAtomic');
  decimal(input.nextLotNonce, 'nextLotNonce');
  decimal(input.sourceSlot, 'sourceSlot');
  validateCommitment(input.commitment, 'commitment');
  timestamp(input.observedAtIso, 'observedAtIso');
}

function validateSettlementEvent(input: EscrowSettlementEventInput): void {
  chainIdentity(input.signature, input.instructionIndex);
  uuidInput(input.marketId, 'marketId');
  nonempty(input.programId, 'programId');
  hash(input.evidenceHashHex, 'evidenceHashHex');
  hash(input.documentHashHex, 'documentHashHex');
  decimal(input.oracleEpoch, 'oracleEpoch');
  decimal(input.slot, 'slot');
  optionalTimestamp(input.blockTimeIso, 'blockTimeIso');
  validateCommitment(input.commitment, 'commitment');
  timestamp(input.observedAtIso, 'observedAtIso');
}

function validateClaimEvent(input: EscrowClaimEventInput): void {
  chainIdentity(input.signature, input.instructionIndex);
  uuidInput(input.marketId, 'marketId');
  nonempty(input.programId, 'programId');
  nonempty(input.ownerPubkey, 'ownerPubkey');
  nonempty(input.destinationPubkey, 'destinationPubkey');
  validateAsset(input.asset, 'asset');
  decimal(input.amountAtomic, 'amountAtomic', true);
  decimal(input.slot, 'slot');
  optionalTimestamp(input.blockTimeIso, 'blockTimeIso');
  validateCommitment(input.commitment, 'commitment');
  timestamp(input.observedAtIso, 'observedAtIso');
}

function validateCursor(input: AdvanceEscrowChainCursorInput): void {
  validateCluster(input.cluster, 'cluster');
  nonempty(input.genesisHash, 'genesisHash');
  nonempty(input.programId, 'programId');
  validateCommitment(input.commitment, 'commitment');
  decimal(input.slot, 'slot');
  nonempty(input.signature, 'signature');
  timestamp(input.nowIso, 'nowIso');
}

function validateGetChainCursor(input: GetEscrowChainCursorInput): void {
  validateCluster(input.cluster, 'cluster');
  boundedNonempty(input.genesisHash, 'genesisHash');
  boundedNonempty(input.programId, 'programId');
}

function validateReconciliation(input: RecordEscrowReconciliationInput): void {
  uuidInput(input.marketId, 'marketId');
  validateCluster(input.cluster, 'cluster');
  nonempty(input.programId, 'programId');
  decimal(input.checkedSlot, 'checkedSlot');
  decimal(input.vaultBalanceAtomic, 'vaultBalanceAtomic');
  decimal(input.liabilityAtomic, 'liabilityAtomic');
  safeInteger(input.positionAccountCount, 'positionAccountCount');
  validateReconciliationStatus(input.status, 'status');
  timestamp(input.checkedAtIso, 'checkedAtIso');
}

function validateCreateSigningSession(input: CreateDurableEscrowSigningSessionInput): void {
  hash(input.tokenHashHex, 'tokenHashHex');
  safeInteger(input.userId, 'userId', true);
  nonempty(input.providerUserId, 'providerUserId');
  nonempty(input.providerWalletId, 'providerWalletId');
  nonempty(input.ownerPubkey, 'ownerPubkey');
  uuidInput(input.marketId, 'marketId');
  if (input.side !== 'back' && input.side !== 'doubt') invalid('side');
  validateAsset(input.asset, 'asset');
  decimal(input.amountAtomic, 'amountAtomic', true);
  decimal(input.lotNonce, 'lotNonce');
  decimal(input.eventEpoch, 'eventEpoch');
  hash(input.documentHashHex, 'documentHashHex');
  hash(input.transactionMessageHashHex, 'transactionMessageHashHex');
  base64Input(input.rawTransactionBase64, 'rawTransactionBase64');
  timestamp(input.expiresAtIso, 'expiresAtIso');
  timestamp(input.nowIso, 'nowIso');
  validateAuthorization(input.authorization, input);
}

function validateGetSigningSession(input: GetEscrowSigningSessionInput): void {
  hash(input.tokenHashHex, 'tokenHashHex');
  timestamp(input.nowIso, 'nowIso');
}

function validateConsumeSigningSession(input: ConsumeEscrowSigningSessionInput): void {
  hash(input.tokenHashHex, 'tokenHashHex');
  safeInteger(input.userId, 'userId', true);
  nonempty(input.providerUserId, 'providerUserId');
  nonempty(input.providerWalletId, 'providerWalletId');
  nonempty(input.ownerPubkey, 'ownerPubkey');
  uuidInput(input.marketId, 'marketId');
  hash(input.transactionMessageHashHex, 'transactionMessageHashHex');
  nonempty(input.transactionSignature, 'transactionSignature');
  timestamp(input.nowIso, 'nowIso');
}

function validateConsumeAndEnqueuePlacement(
  input: ConsumeEscrowSigningSessionAndEnqueuePlacementInput,
): void {
  validateConsumeSigningSession(input);
  validateEnqueue({ ...input, kind: 'position_placement' });
  timestamp(input.dueAtIso, 'dueAtIso');
}

function validateListReconciliationLinks(input: ListEscrowReconciliationLinksInput): void {
  validateCluster(input.cluster, 'cluster');
  boundedNonempty(input.genesisHash, 'genesisHash');
  boundedNonempty(input.programId, 'programId');
  safeInteger(input.custodyVersion, 'custodyVersion', true);
  if (input.cursor !== null) uuidInput(input.cursor, 'cursor');
  safeInteger(input.limit, 'limit', true);
  if (input.limit > 1_000) invalid('limit');
}

function validateEnqueue(input: DurableEnqueueEscrowRelayerJobInput): void {
  relayerKind('escrow_relayer_enqueue', input.kind);
  nonempty(input.idempotencyKey, 'idempotencyKey');
  validateCluster(input.cluster, 'cluster');
  nonempty(input.programId, 'programId');
  if (input.custodyMode !== 'escrow') invalid('custodyMode');
  safeInteger(input.custodyVersion, 'custodyVersion', true);
  if (input.marketId !== null) uuidInput(input.marketId, 'marketId');
  if (input.ownerPubkey !== null) nonempty(input.ownerPubkey, 'ownerPubkey');
  timestamp(input.dueAtIso, 'dueAtIso');
  safeInteger(input.maxAttempts, 'maxAttempts', true);
  safeInteger(input.leaseMs ?? 60_000, 'leaseMs', true);
  timestamp(input.nowIso, 'nowIso');
}

function validateLease(input: LeaseEscrowRelayerJobsInput): void {
  nonempty(input.workerId, 'workerId');
  timestamp(input.nowIso, 'nowIso');
  safeInteger(input.limit, 'limit', true);
}

function validateLeaseTransition(input: EscrowRelayerLeaseTransitionInput): void {
  uuidInput(input.jobId, 'jobId');
  nonempty(input.workerId, 'workerId');
  uuidInput(input.leaseToken, 'leaseToken');
  timestamp(input.nowIso, 'nowIso');
}

function validateSigned(input: RecordEscrowRelayerSignedTransactionInput): void {
  validateLeaseTransition(input);
  nonempty(input.rawTransactionBase64, 'rawTransactionBase64');
  nonempty(input.expectedSignature, 'expectedSignature');
  decimal(input.lastValidBlockHeight, 'lastValidBlockHeight');
  hash(input.transactionMessageHashHex, 'transactionMessageHashHex');
}

function leaseArgs(input: EscrowRelayerLeaseTransitionInput): Record<string, unknown> {
  return {
    p_job_id: input.jobId,
    p_worker_id: input.workerId,
    p_lease_token: input.leaseToken,
    p_now: input.nowIso,
  };
}

function chainIdentity(signature: string, instructionIndex: number): void {
  nonempty(signature, 'signature');
  safeInteger(instructionIndex, 'instructionIndex');
}

function decimal(value: bigint, field: string, positive = false): string {
  if (typeof value !== 'bigint' || value < 0n || (positive && value === 0n)) invalid(field);
  return value.toString(10);
}

function safeInteger(value: number, field: string, positive = false): void {
  if (!Number.isSafeInteger(value) || value < 0 || (positive && value === 0)) invalid(field);
}

function uuidInput(value: string, field: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) invalid(field);
}

function hash(value: string, field: string): void {
  if (!/^[0-9a-f]{64}$/i.test(value)) invalid(field);
}

const AUTHORIZATION_KEYS = [
  'schemaVersion',
  'programId',
  'relayerFeePayer',
  'canonicalUsdcMint',
  'marketUuid',
  'marketPda',
  'marketDocumentHashHex',
  'side',
  'amount',
  'asset',
  'expectedRatioMilli',
  'expectedEventEpoch',
  'expectedLotNonce',
  'expiresAt',
  'genesisHash',
  'recentBlockhash',
  'lastValidBlockHeight',
  'messageHashHex',
] as const;

function validateAuthorization(
  value: EscrowSigningSessionAuthorizationPayload,
  binding: CreateDurableEscrowSigningSessionInput,
): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('authorization');
  const record = value as unknown as Record<string, unknown>;
  if (
    Object.keys(record).length !== AUTHORIZATION_KEYS.length
    || AUTHORIZATION_KEYS.some((key) => !(key in record))
    || value.schemaVersion !== 1
  ) invalid('authorization');
  boundedNonempty(value.programId, 'authorization.programId');
  boundedNonempty(value.relayerFeePayer, 'authorization.relayerFeePayer');
  boundedNonempty(value.canonicalUsdcMint, 'authorization.canonicalUsdcMint');
  uuidInput(value.marketUuid, 'authorization.marketUuid');
  boundedNonempty(value.marketPda, 'authorization.marketPda');
  boundedNonempty(value.genesisHash, 'authorization.genesisHash');
  boundedNonempty(value.recentBlockhash, 'authorization.recentBlockhash');
  hash(value.marketDocumentHashHex, 'authorization.marketDocumentHashHex');
  hash(value.messageHashHex, 'authorization.messageHashHex');
  unsignedDecimalString(value.amount, 'authorization.amount', true);
  unsignedDecimalString(value.expectedRatioMilli, 'authorization.expectedRatioMilli', true);
  unsignedDecimalString(value.expectedEventEpoch, 'authorization.expectedEventEpoch');
  unsignedDecimalString(value.expectedLotNonce, 'authorization.expectedLotNonce');
  unsignedDecimalString(value.expiresAt, 'authorization.expiresAt', true);
  unsignedDecimalString(value.lastValidBlockHeight, 'authorization.lastValidBlockHeight', true);
  const expiresAtMillis = Date.parse(binding.expiresAtIso);
  if (
    value.marketUuid !== binding.marketId
    || value.side !== binding.side
    || value.asset !== binding.asset
    || value.amount !== binding.amountAtomic.toString()
    || value.expectedEventEpoch !== binding.eventEpoch.toString()
    || value.expectedLotNonce !== binding.lotNonce.toString()
    || value.marketDocumentHashHex.toLowerCase() !== binding.documentHashHex.toLowerCase()
    || value.messageHashHex.toLowerCase() !== binding.transactionMessageHashHex.toLowerCase()
    || expiresAtMillis % 1_000 !== 0
    || value.expiresAt !== String(expiresAtMillis / 1_000)
  ) invalid('authorizationBinding');
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 8_192) invalid('authorization');
}

function authorizationValue(operation: string, value: unknown): EscrowSigningSessionAuthorizationPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return malformed(operation, 'authorization');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== AUTHORIZATION_KEYS.length || AUTHORIZATION_KEYS.some((key) => !(key in record))) {
    return malformed(operation, 'authorization');
  }
  if (record.schemaVersion !== 1) return malformed(operation, 'authorization.schemaVersion');
  return {
    schemaVersion: 1,
    programId: boundedStringValue(operation, record.programId, 'authorization.programId'),
    relayerFeePayer: boundedStringValue(operation, record.relayerFeePayer, 'authorization.relayerFeePayer'),
    canonicalUsdcMint: boundedStringValue(operation, record.canonicalUsdcMint, 'authorization.canonicalUsdcMint'),
    marketUuid: uuid(operation, record.marketUuid, 'authorization.marketUuid'),
    marketPda: boundedStringValue(operation, record.marketPda, 'authorization.marketPda'),
    marketDocumentHashHex: hashValue(operation, record.marketDocumentHashHex, 'authorization.marketDocumentHashHex'),
    side: signingSide(operation, record.side),
    amount: decimalStringValue(operation, record.amount, 'authorization.amount', true),
    asset: signingAsset(operation, record.asset),
    expectedRatioMilli: decimalStringValue(operation, record.expectedRatioMilli, 'authorization.expectedRatioMilli', true),
    expectedEventEpoch: decimalStringValue(operation, record.expectedEventEpoch, 'authorization.expectedEventEpoch'),
    expectedLotNonce: decimalStringValue(operation, record.expectedLotNonce, 'authorization.expectedLotNonce'),
    expiresAt: decimalStringValue(operation, record.expiresAt, 'authorization.expiresAt', true),
    genesisHash: boundedStringValue(operation, record.genesisHash, 'authorization.genesisHash'),
    recentBlockhash: boundedStringValue(operation, record.recentBlockhash, 'authorization.recentBlockhash'),
    lastValidBlockHeight: decimalStringValue(operation, record.lastValidBlockHeight, 'authorization.lastValidBlockHeight', true),
    messageHashHex: hashValue(operation, record.messageHashHex, 'authorization.messageHashHex'),
  };
}

function signingSide(operation: string, value: unknown): 'back' | 'doubt' {
  if (value === 'back' || value === 'doubt') return value;
  return malformed(operation, 'side');
}

function signingAsset(operation: string, value: unknown): EscrowAsset {
  if (value === 'sol' || value === 'usdc') return value;
  return malformed(operation, 'asset');
}

function hashValue(operation: string, value: unknown, field: string): string {
  const parsed = string(operation, value, field);
  if (/^[0-9a-f]{64}$/i.test(parsed)) return parsed;
  return malformed(operation, field);
}

function base64Input(value: string, field: string): void {
  if (
    value.length === 0
    || value.length > 4_096
    || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
    || Buffer.from(value, 'base64').toString('base64') !== value
  ) invalid(field);
}

function base64Value(operation: string, value: unknown, field: string): string {
  const parsed = string(operation, value, field);
  if (
    parsed.length > 0
    && parsed.length <= 4_096
    && parsed.length % 4 === 0
    && /^[A-Za-z0-9+/]+={0,2}$/.test(parsed)
    && Buffer.from(parsed, 'base64').toString('base64') === parsed
  ) return parsed;
  return malformed(operation, field);
}

function unsignedDecimalString(value: string, field: string, positive = false): void {
  const expression = positive ? /^[1-9][0-9]{0,19}$/ : /^(?:0|[1-9][0-9]{0,19})$/;
  if (!expression.test(value)) invalid(field);
}

function decimalStringValue(
  operation: string,
  value: unknown,
  field: string,
  positive = false,
): string {
  const parsed = string(operation, value, field);
  const expression = positive ? /^[1-9][0-9]{0,19}$/ : /^(?:0|[1-9][0-9]{0,19})$/;
  if (expression.test(parsed)) return parsed;
  return malformed(operation, field);
}

function boundedNonempty(value: string, field: string): void {
  nonempty(value, field);
  if (value.length > 128) invalid(field);
}

function boundedStringValue(operation: string, value: unknown, field: string): string {
  const parsed = string(operation, value, field);
  if (parsed.length > 0 && parsed.length <= 128) return parsed;
  return malformed(operation, field);
}

function nonempty(value: string | null, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') invalid(field);
}

function timestamp(value: string, field: string): void {
  if (!isTimestamp(value)) invalid(field);
}

function optionalTimestamp(value: string | null, field: string): void {
  if (value !== null) timestamp(value, field);
}

function isTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function validateCluster(value: EscrowCluster, field: string): void {
  if (value !== 'localnet' && value !== 'devnet' && value !== 'mainnet-beta') invalid(field);
}

function validateAsset(value: EscrowAsset, field: string): void {
  if (value !== 'sol' && value !== 'usdc') invalid(field);
}

function validateCommitment(value: EscrowCommitment, field: string): void {
  if (value !== 'confirmed' && value !== 'finalized') invalid(field);
}

function validateReconciliationStatus(value: EscrowReconciliationStatus, field: string): void {
  if (value !== 'in_sync' && value !== 'drift' && value !== 'unavailable') invalid(field);
}

function escrowCustodyMode(operation: string, value: unknown): 'escrow' {
  if (value === 'escrow') return value;
  return malformed(operation, 'custody_mode');
}

function invalid(field: string): never {
  throw new DbError('escrowInput', { message: `invalid ${field}` });
}

export type {
  EscrowDb,
  EscrowRelayerBacklog,
  EscrowRelayerJobRow,
  EscrowRelayerMutationResult,
  EscrowSigningSessionResult,
  ConsumeEscrowSigningSessionAndEnqueuePlacementResult,
  ListEscrowReconciliationLinksResult,
  RewindEscrowConfirmedChainResult,
};
