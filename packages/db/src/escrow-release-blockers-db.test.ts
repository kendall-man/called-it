import { describe, expect, it } from 'vitest';
import type { PgResult } from './errors.js';
import { escrowDbFromClient, type EscrowDbClient } from './escrow-db.js';

const MARKET_ID = '02600000-0000-4000-8000-000000000001';
const RELAYER_JOB_ID = '02600000-0000-4000-8000-000000000002';
const LEASE_TOKEN = '02600000-0000-4000-8000-000000000003';
const REQUEST_KEY = '01'.repeat(32);
const HASH = 'ab'.repeat(32);
const SIGNED_HASH = 'cd'.repeat(32);
const NOW = '2026-07-15T12:00:00.000Z';
const LATER = '2026-07-15T12:01:00.000Z';

type RpcCall = Readonly<{ fn: string; args: Readonly<Record<string, unknown>> }>;

class FakeEscrowClient implements EscrowDbClient {
  readonly calls: RpcCall[] = [];
  response: PgResult<unknown> = { data: null, error: { message: 'missing fake response' } };

  rpc(fn: string, args: Record<string, unknown>): Promise<PgResult<unknown>> {
    this.calls.push({ fn, args });
    return Promise.resolve(this.response);
  }
}

function makeDb(response: PgResult<unknown>) {
  const client = new FakeEscrowClient();
  client.response = response;
  return { client, db: escrowDbFromClient(client) };
}

function enqueueInput() {
  return {
    requestKey: REQUEST_KEY,
    operationKind: 'settle' as const,
    cluster: 'devnet' as const,
    genesisHash: 'genesis-address',
    programId: 'program-address',
    custodyVersion: 2,
    marketId: MARKET_ID,
    marketPda: 'market-address',
    documentHashHex: HASH,
    oracleEpoch: 9n,
    eventEpoch: 4n,
    unsignedPayload: { schemaVersion: 1, outcome: 'claim_won' },
    unsignedPayloadHashHex: HASH,
    dueAtIso: NOW,
    debounceUntilIso: LATER,
    maxAttempts: 5,
    leaseMs: 45_000,
    nowIso: NOW,
  };
}

describe('0026 escrow typed facade', () => {
  it('configures and reads exact group rollout identity', async () => {
    const { client, db } = makeDb({
      data: {
        ok: true,
        created: true,
        group_id: 926001,
        custody_mode: 'escrow',
        cluster: 'devnet',
        genesis_hash: 'genesis-address',
        program_id: 'program-address',
        custody_version: 2,
        enabled_by: 926101,
        updated_at: NOW,
      },
      error: null,
    });

    await expect(db.configureGroupRollout({
      groupId: 926001,
      custodyMode: 'escrow',
      cluster: 'devnet',
      genesisHash: 'genesis-address',
      programId: 'program-address',
      custodyVersion: 2,
      enabledBy: 926101,
      nowIso: NOW,
    })).resolves.toEqual({
      ok: true,
      created: true,
      groupId: 926001,
      custodyMode: 'escrow',
      cluster: 'devnet',
      genesisHash: 'genesis-address',
      programId: 'program-address',
      custodyVersion: 2,
      enabledBy: 926101,
      updatedAtIso: NOW,
    });
    expect(client.calls[0]).toEqual({
      fn: 'escrow_configure_group_rollout',
      args: {
        p_group_id: 926001,
        p_custody_mode: 'escrow',
        p_cluster: 'devnet',
        p_genesis_hash: 'genesis-address',
        p_program_id: 'program-address',
        p_custody_version: 2,
        p_enabled_by: 926101,
        p_now: NOW,
      },
    });

    client.response = {
      data: {
        ok: true,
        found: true,
        group_id: 926001,
        custody_mode: 'escrow',
        cluster: 'devnet',
        genesis_hash: 'genesis-address',
        program_id: 'program-address',
        custody_version: 2,
        enabled_by: 926101,
        updated_at: NOW,
      },
      error: null,
    };
    await expect(db.getGroupRollout({ groupId: 926001 })).resolves.toMatchObject({
      ok: true,
      found: true,
      groupId: 926001,
      custodyMode: 'escrow',
      genesisHash: 'genesis-address',
    });
    expect(client.calls[1]).toEqual({
      fn: 'escrow_get_group_rollout',
      args: { p_group_id: 926001 },
    });
  });

  it('records the fully-bound finalized MarketClosed projection', async () => {
    const { client, db } = makeDb({
      data: { ok: true, duplicate: false, finalized: true },
      error: null,
    });

    await expect(db.recordMarketClosed({
      signature: 'close-signature',
      instructionIndex: 3,
      marketId: MARKET_ID,
      cluster: 'devnet',
      genesisHash: 'genesis-address',
      programId: 'program-address',
      marketPda: 'market-address',
      documentHashHex: HASH,
      asset: 'usdc',
      dustAmountAtomic: 99n,
      slot: 1_234n,
      blockTimeIso: NOW,
      commitment: 'finalized',
      observedAtIso: NOW,
    })).resolves.toEqual({ ok: true, duplicate: false, finalized: true });

    expect(client.calls).toEqual([{
      fn: 'escrow_index_market_closed',
      args: {
        p_signature: 'close-signature',
        p_instruction_index: 3,
        p_market_id: MARKET_ID,
        p_cluster: 'devnet',
        p_genesis_hash: 'genesis-address',
        p_program_id: 'program-address',
        p_market_pda: 'market-address',
        p_document_hash_hex: HASH,
        p_asset: 'usdc',
        p_dust_amount_atomic: '99',
        p_slot: '1234',
        p_block_time: NOW,
        p_commitment: 'finalized',
        p_observed_at: NOW,
      },
    }]);
  });

  it('enqueues deterministic workflow intent and parses durable leases', async () => {
    const { client, db } = makeDb({
      data: { ok: true, created: true, request_key: REQUEST_KEY },
      error: null,
    });

    await expect(db.enqueueAttestationRequest(enqueueInput())).resolves.toEqual({
      ok: true,
      created: true,
      requestKey: REQUEST_KEY,
    });
    expect(client.calls[0]).toEqual({
      fn: 'escrow_attestation_enqueue',
      args: {
        p_request_key: REQUEST_KEY,
        p_operation_kind: 'settle',
        p_cluster: 'devnet',
        p_genesis_hash: 'genesis-address',
        p_program_id: 'program-address',
        p_custody_version: 2,
        p_market_id: MARKET_ID,
        p_market_pda: 'market-address',
        p_document_hash_hex: HASH,
        p_oracle_epoch: '9',
        p_event_epoch: '4',
        p_unsigned_payload: { schemaVersion: 1, outcome: 'claim_won' },
        p_unsigned_payload_hash_hex: HASH,
        p_due_at: NOW,
        p_debounce_until: LATER,
        p_max_attempts: 5,
        p_lease_ms: 45_000,
        p_now: NOW,
      },
    });

    client.response = {
      data: [{
        request_key: REQUEST_KEY,
        operation_kind: 'settle',
        state: 'leased',
        cluster: 'devnet',
        genesis_hash: 'genesis-address',
        program_id: 'program-address',
        custody_version: 2,
        market_id: MARKET_ID,
        market_pda: 'market-address',
        document_hash_hex: HASH,
        oracle_epoch: '9',
        event_epoch: '4',
        unsigned_payload: { schemaVersion: 1, outcome: 'claim_won' },
        unsigned_payload_hash_hex: HASH,
        signed_payload: null,
        signed_payload_hash_hex: null,
        due_at: NOW,
        debounce_until: LATER,
        relayer_job_id: null,
        attempts: 1,
        max_attempts: 5,
        lease_duration_ms: 45_000,
        lease_owner: 'worker-a',
        lease_token: LEASE_TOKEN,
        lease_expires_at: LATER,
        error_code: null,
        created_at: NOW,
        updated_at: NOW,
        signed_at: null,
        enqueued_at: null,
        completed_at: null,
        failed_at: null,
      }],
      error: null,
    };
    await expect(db.leaseAttestationRequests({
      workerId: 'worker-a',
      nowIso: NOW,
      limit: 10,
    })).resolves.toEqual([expect.objectContaining({
      requestKey: REQUEST_KEY,
      operationKind: 'settle',
      state: 'leased',
      oracleEpoch: 9n,
      eventEpoch: 4n,
      leaseToken: LEASE_TOKEN,
    })]);
  });

  it('accepts null debounce for immediate operations and leaves normalization to SQL', async () => {
    const { client, db } = makeDb({
      data: { ok: true, created: true, request_key: REQUEST_KEY },
      error: null,
    });

    await expect(db.enqueueAttestationRequest({
      ...enqueueInput(),
      operationKind: 'freeze',
      debounceUntilIso: null,
    })).resolves.toEqual({ ok: true, created: true, requestKey: REQUEST_KEY });
    expect(client.calls[0]?.args.p_debounce_until).toBeNull();
    expect(client.calls[0]?.args.p_due_at).toBe(NOW);
  });

  it('fences signed, enqueued, completed, and retry transitions', async () => {
    const { client, db } = makeDb({
      data: { ok: true, duplicate: false, state: 'signed' },
      error: null,
    });
    const lease = {
      requestKey: REQUEST_KEY,
      workerId: 'worker-a',
      leaseToken: LEASE_TOKEN,
      nowIso: NOW,
    };

    await expect(db.recordAttestationSigned({
      ...lease,
      signedPayload: { schemaVersion: 1, signatures: ['oracle-a'] },
      signedPayloadHashHex: SIGNED_HASH,
    })).resolves.toEqual({ ok: true, duplicate: false, state: 'signed' });
    expect(client.calls.at(-1)).toEqual({
      fn: 'escrow_attestation_record_signed',
      args: {
        p_request_key: REQUEST_KEY,
        p_worker_id: 'worker-a',
        p_lease_token: LEASE_TOKEN,
        p_now: NOW,
        p_signed_payload: { schemaVersion: 1, signatures: ['oracle-a'] },
        p_signed_payload_hash_hex: SIGNED_HASH,
      },
    });

    client.response = { data: { ok: true, duplicate: false, state: 'enqueued' }, error: null };
    await expect(db.markAttestationEnqueued({
      ...lease,
      relayerJobId: RELAYER_JOB_ID,
      nextCheckAtIso: LATER,
    })).resolves.toEqual({ ok: true, duplicate: false, state: 'enqueued' });
    expect(client.calls.at(-1)).toEqual({
      fn: 'escrow_attestation_mark_enqueued',
      args: {
        p_request_key: REQUEST_KEY,
        p_worker_id: 'worker-a',
        p_lease_token: LEASE_TOKEN,
        p_now: NOW,
        p_relayer_job_id: RELAYER_JOB_ID,
        p_next_check_at: LATER,
      },
    });

    client.response = { data: { ok: true, duplicate: false, state: 'completed' }, error: null };
    await expect(db.completeAttestationRequest(lease)).resolves.toEqual({
      ok: true,
      duplicate: false,
      state: 'completed',
    });
    expect(client.calls.at(-1)).toEqual({
      fn: 'escrow_attestation_complete',
      args: {
        p_request_key: REQUEST_KEY,
        p_worker_id: 'worker-a',
        p_lease_token: LEASE_TOKEN,
        p_now: NOW,
      },
    });

    client.response = { data: { ok: true, duplicate: false, state: 'signed' }, error: null };
    await expect(db.retryAttestationRequest({
      ...lease,
      errorCode: 'rpc_unavailable',
      retryAtIso: LATER,
    })).resolves.toEqual({ ok: true, duplicate: false, state: 'signed' });
    expect(client.calls.at(-1)).toEqual({
      fn: 'escrow_attestation_retry',
      args: {
        p_request_key: REQUEST_KEY,
        p_worker_id: 'worker-a',
        p_lease_token: LEASE_TOKEN,
        p_now: NOW,
        p_error_code: 'rpc_unavailable',
        p_retry_at: LATER,
      },
    });
  });

  it('rejects private payload keys before making a database call', async () => {
    const { client, db } = makeDb({
      data: { ok: true, created: true, request_key: REQUEST_KEY },
      error: null,
    });

    expect(() => db.enqueueAttestationRequest({
      ...enqueueInput(),
      unsignedPayload: { evidence: { signingToken: 'must-not-persist' } },
    })).toThrow('unsignedPayload');
    expect(client.calls).toHaveLength(0);
  });
});
