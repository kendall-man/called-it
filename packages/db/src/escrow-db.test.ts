import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PgResult } from './errors.js';
import {
  escrowDbFromClient,
  type EscrowDbClient,
} from './escrow-db.js';

const MARKET_ID = '00000000-0000-4000-8000-000000000024';
const JOB_ID = '00000000-0000-4000-8000-000000000025';
const LEASE_TOKEN = '00000000-0000-4000-8000-000000000026';
const NOW = '2026-07-15T12:00:00.000Z';
const LATER = '2026-07-15T12:10:00.000Z';
const HASH = 'ab'.repeat(32);
const RAW_TRANSACTION_BASE64 = 'AQID';
const GENESIS_HASH = 'devnet-genesis-hash';
const PROGRAM_ID = 'program-address';
const MARKET_PDA = 'market-address';

function authorization(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    schemaVersion: 1 as const,
    programId: 'program-address',
    relayerFeePayer: 'sponsor-address',
    canonicalUsdcMint: 'canonical-usdc-mint',
    marketUuid: MARKET_ID,
    marketPda: 'market-address',
    marketDocumentHashHex: HASH,
    side: 'doubt' as const,
    amount: '10000000',
    asset: 'sol' as const,
    expectedRatioMilli: '1500',
    expectedEventEpoch: '8',
    expectedLotNonce: '3',
    expiresAt: String(Date.parse(LATER) / 1_000),
    genesisHash: 'devnet-genesis-hash',
    recentBlockhash: 'recent-blockhash',
    lastValidBlockHeight: '900',
    messageHashHex: HASH,
    ...overrides,
  };
}

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

describe('escrowDbFromClient', () => {
  it('records position events using decimal strings for atomic amounts', async () => {
    const { client, db } = makeDb({
      data: { ok: true, duplicate: false, finalized: true },
      error: null,
    });

    await expect(db.recordPositionEvent({
      signature: 'position-signature',
      instructionIndex: 2,
      marketId: MARKET_ID,
      programId: 'program-address',
      positionPda: 'position-address',
      ownerPubkey: 'owner-address',
      lotNonce: 7n,
      eventKind: 'placed',
      side: 'back',
      asset: 'usdc',
      amountAtomic: 9_007_199_254_740_993n,
      eventEpoch: 11n,
      state: 'active',
      slot: 123_456n,
      blockTimeIso: NOW,
      commitment: 'finalized',
      observedAtIso: NOW,
    })).resolves.toEqual({ ok: true, duplicate: false, finalized: true });

    expect(client.calls).toEqual([{
      fn: 'escrow_index_position_event',
      args: {
        p_signature: 'position-signature',
        p_instruction_index: 2,
        p_market_id: MARKET_ID,
        p_program_id: 'program-address',
        p_position_pda: 'position-address',
        p_owner_pubkey: 'owner-address',
        p_lot_nonce: '7',
        p_event_kind: 'placed',
        p_side: 'back',
        p_asset: 'usdc',
        p_amount_atomic: '9007199254740993',
        p_event_epoch: '11',
        p_state: 'active',
        p_slot: '123456',
        p_block_time: NOW,
        p_commitment: 'finalized',
        p_observed_at: NOW,
      },
    }]);
  });

  it('rewinds only confirmed state through the explicit reorg RPC', async () => {
    const { client, db } = makeDb({
      data: { ok: true, orphaned_events: 4, rewind_slot: '500' },
      error: null,
    });

    await expect(db.rewindConfirmedChain({
      cluster: 'devnet',
      programId: 'program-address',
      rewindSlot: 500n,
      nowIso: NOW,
    })).resolves.toEqual({ ok: true, orphanedEvents: 4, rewindSlot: 500n });

    expect(client.calls).toEqual([{
      fn: 'escrow_rewind_confirmed_chain',
      args: {
        p_cluster: 'devnet',
        p_program_id: 'program-address',
        p_rewind_slot: '500',
        p_now: NOW,
      },
    }]);
  });

  it('returns an exact zero cursor only when no durable cursor exists', async () => {
    const { client, db } = makeDb({
      data: {
        ok: true,
        initialized: false,
        cluster: 'devnet',
        genesis_hash: GENESIS_HASH,
        program_id: PROGRAM_ID,
        last_confirmed_slot: '0',
        last_confirmed_signature: null,
        last_finalized_slot: '0',
        last_finalized_signature: null,
        updated_at: null,
      },
      error: null,
    });

    await expect(db.getChainCursor({
      cluster: 'devnet',
      genesisHash: GENESIS_HASH,
      programId: PROGRAM_ID,
    })).resolves.toEqual({
      ok: true,
      initialized: false,
      cluster: 'devnet',
      genesisHash: GENESIS_HASH,
      programId: PROGRAM_ID,
      confirmedSlot: 0n,
      confirmedSignature: null,
      finalizedSlot: 0n,
      finalizedSignature: null,
      updatedAtIso: null,
    });
    expect(client.calls).toEqual([{
      fn: 'escrow_get_chain_cursor',
      args: {
        p_cluster: 'devnet',
        p_genesis_hash: GENESIS_HASH,
        p_program_id: PROGRAM_ID,
      },
    }]);
  });

  it('returns ordered confirmed/finalized cursors and fails closed on mismatch', async () => {
    const { client, db } = makeDb({
      data: {
        ok: true,
        initialized: true,
        cluster: 'devnet',
        genesis_hash: GENESIS_HASH,
        program_id: PROGRAM_ID,
        last_confirmed_slot: '120',
        last_confirmed_signature: 'confirmed-signature',
        last_finalized_slot: '115',
        last_finalized_signature: 'finalized-signature',
        updated_at: NOW,
      },
      error: null,
    });
    await expect(db.getChainCursor({
      cluster: 'devnet', genesisHash: GENESIS_HASH, programId: PROGRAM_ID,
    })).resolves.toMatchObject({
      ok: true,
      initialized: true,
      confirmedSlot: 120n,
      finalizedSlot: 115n,
    });

    client.response = { data: { ok: false, code: 'genesis_mismatch' }, error: null };
    await expect(db.getChainCursor({
      cluster: 'devnet', genesisHash: 'different-genesis', programId: PROGRAM_ID,
    })).resolves.toEqual({ ok: false, code: 'genesis_mismatch' });

    client.response = {
      data: {
        ok: true,
        initialized: true,
        cluster: 'devnet',
        genesis_hash: GENESIS_HASH,
        program_id: PROGRAM_ID,
        last_confirmed_slot: '120',
        last_confirmed_signature: 'confirmed-signature',
        last_finalized_slot: '121',
        last_finalized_signature: 'finalized-signature',
        updated_at: NOW,
      },
      error: null,
    };
    await expect(db.getChainCursor({
      cluster: 'devnet', genesisHash: GENESIS_HASH, programId: PROGRAM_ID,
    })).rejects.toThrow('cursor_binding');
  });

  it('loads a canonical escrow market link by its full chain identity', async () => {
    const { client, db } = makeDb({
      data: {
        ok: true,
        found: true,
        market_id: MARKET_ID,
        custody_mode: 'escrow',
        market_custody_mode: 'escrow',
        custody_version: 1,
        cluster: 'devnet',
        genesis_hash: GENESIS_HASH,
        program_id: PROGRAM_ID,
        market_pda: MARKET_PDA,
        vault_pda: 'vault-address',
        asset: 'usdc',
        mint_pubkey: 'canonical-usdc-mint',
        document_hash_hex: HASH,
        oracle_epoch: '9',
        event_epoch: '4',
        ratio_milli: '1500',
        chain_state: 'closed',
        commitment: 'finalized',
        canonical: true,
        projection_stale: false,
      },
      error: null,
    });

    await expect(db.getMarketLink({
      cluster: 'devnet',
      genesisHash: GENESIS_HASH,
      programId: PROGRAM_ID,
      marketPda: MARKET_PDA,
    })).resolves.toEqual({
      ok: true,
      found: true,
      marketId: MARKET_ID,
      custodyMode: 'escrow',
      custodyVersion: 1,
      cluster: 'devnet',
      genesisHash: GENESIS_HASH,
      programId: PROGRAM_ID,
      marketPda: MARKET_PDA,
      vaultPda: 'vault-address',
      asset: 'usdc',
      mintPubkey: 'canonical-usdc-mint',
      documentHashHex: HASH,
      oracleEpoch: 9n,
      eventEpoch: 4n,
      ratioMilli: 1_500n,
      chainState: 'closed',
      commitment: 'finalized',
      projectionStale: false,
    });
    expect(client.calls[0]).toEqual({
      fn: 'escrow_get_market_link',
      args: {
        p_cluster: 'devnet',
        p_genesis_hash: GENESIS_HASH,
        p_program_id: PROGRAM_ID,
        p_market_pda: MARKET_PDA,
      },
    });
  });

  it('propagates market identity failures and rejects mismatched success payloads', async () => {
    const { client, db } = makeDb({
      data: { ok: false, code: 'noncanonical' },
      error: null,
    });
    await expect(db.getMarketLink({
      cluster: 'devnet', genesisHash: GENESIS_HASH, programId: PROGRAM_ID, marketPda: MARKET_PDA,
    })).resolves.toEqual({ ok: false, code: 'noncanonical' });

    client.response = {
      data: {
        ok: true, found: true, market_id: MARKET_ID, custody_mode: 'escrow',
        market_custody_mode: 'escrow', custody_version: 1, cluster: 'devnet',
        genesis_hash: 'wrong-genesis', program_id: PROGRAM_ID, market_pda: MARKET_PDA,
        vault_pda: 'vault-address', asset: 'sol', mint_pubkey: null,
        document_hash_hex: HASH, oracle_epoch: '9', event_epoch: '4', ratio_milli: '1500',
        chain_state: 'open', commitment: 'confirmed', canonical: true, projection_stale: false,
      },
      error: null,
    };
    await expect(db.getMarketLink({
      cluster: 'devnet', genesisHash: GENESIS_HASH, programId: PROGRAM_ID, marketPda: MARKET_PDA,
    })).rejects.toThrow('market_binding');
  });

  it('creates and consumes a bound single-use signing session', async () => {
    const { client, db } = makeDb({
      data: { ok: true, created: true },
      error: null,
    });

    await db.createSigningSession({
      tokenHashHex: HASH,
      userId: 42,
      providerUserId: 'privy-user',
      providerWalletId: 'privy-wallet',
      ownerPubkey: 'owner-address',
      marketId: MARKET_ID,
      side: 'doubt',
      asset: 'sol',
      amountAtomic: 10_000_000n,
      lotNonce: 3n,
      eventEpoch: 8n,
      documentHashHex: HASH,
      transactionMessageHashHex: HASH,
      rawTransactionBase64: RAW_TRANSACTION_BASE64,
      authorization: authorization(),
      expiresAtIso: LATER,
      nowIso: NOW,
    });

    client.response = {
      data: { ok: true, duplicate: false, state: 'consumed' },
      error: null,
    };
    await expect(db.consumeSigningSession({
      tokenHashHex: HASH,
      userId: 42,
      providerUserId: 'privy-user',
      providerWalletId: 'privy-wallet',
      ownerPubkey: 'owner-address',
      marketId: MARKET_ID,
      transactionMessageHashHex: HASH,
      transactionSignature: 'position-signature',
      nowIso: NOW,
    })).resolves.toEqual({ ok: true, duplicate: false, state: 'consumed' });

    expect(client.calls.map((call) => call.fn)).toEqual([
      'escrow_create_signing_session',
      'escrow_consume_signing_session',
    ]);
    expect(client.calls[0]?.args.p_amount_atomic).toBe('10000000');
    expect(client.calls[0]?.args).toMatchObject({
      p_raw_transaction_base64: RAW_TRANSACTION_BASE64,
      p_authorization: authorization(),
    });
    expect(client.calls[1]?.args).toMatchObject({
      p_token_hash_hex: HASH,
      p_transaction_message_hash_hex: HASH,
      p_transaction_signature: 'position-signature',
    });
  });

  it('loads the exact durable presentation by token hash without returning the hash', async () => {
    const { client, db } = makeDb({
      data: {
        ok: true,
        state: 'pending',
        user_id: 42,
        provider_user_id: 'privy-user',
        provider_wallet_id: 'privy-wallet',
        owner_pubkey: 'owner-address',
        market_id: MARKET_ID,
        side: 'doubt',
        asset: 'sol',
        amount_atomic: '10000000',
        lot_nonce: '3',
        event_epoch: '8',
        document_hash_hex: HASH,
        transaction_message_hash_hex: HASH,
        raw_transaction_base64: RAW_TRANSACTION_BASE64,
        authorization: authorization(),
        transaction_signature: null,
        expires_at: LATER,
      },
      error: null,
    });

    await expect(db.getSigningSession({ tokenHashHex: HASH, nowIso: NOW })).resolves.toEqual({
      ok: true,
      state: 'pending',
      userId: 42,
      providerUserId: 'privy-user',
      providerWalletId: 'privy-wallet',
      ownerPubkey: 'owner-address',
      marketId: MARKET_ID,
      side: 'doubt',
      asset: 'sol',
      amountAtomic: 10_000_000n,
      lotNonce: 3n,
      eventEpoch: 8n,
      documentHashHex: HASH,
      transactionMessageHashHex: HASH,
      rawTransactionBase64: RAW_TRANSACTION_BASE64,
      authorization: authorization(),
      transactionSignature: null,
      expiresAtIso: LATER,
    });
    expect(client.calls).toEqual([{
      fn: 'escrow_get_signing_session',
      args: { p_token_hash_hex: HASH, p_now: NOW },
    }]);
  });

  it('rejects a presentation whose authorization differs from its normalized binding', () => {
    const { client, db } = makeDb({ data: { ok: true, created: true }, error: null });
    expect(() => db.createSigningSession({
      tokenHashHex: HASH,
      userId: 42,
      providerUserId: 'privy-user',
      providerWalletId: 'privy-wallet',
      ownerPubkey: 'owner-address',
      marketId: MARKET_ID,
      side: 'doubt',
      asset: 'sol',
      amountAtomic: 10_000_000n,
      lotNonce: 3n,
      eventEpoch: 8n,
      documentHashHex: HASH,
      transactionMessageHashHex: HASH,
      rawTransactionBase64: RAW_TRANSACTION_BASE64,
      authorization: authorization({ amount: '999' }),
      expiresAtIso: LATER,
      nowIso: NOW,
    })).toThrow('authorizationBinding');
    expect(client.calls).toHaveLength(0);
  });

  it('persists signed bytes before submission and retains one expected signature', async () => {
    const { client, db } = makeDb({
      data: { ok: true, created: true, job_id: JOB_ID },
      error: null,
    });

    await db.enqueueRelayerJob({
      kind: 'settlement_submission',
      idempotencyKey: `settle:${MARKET_ID}`,
      cluster: 'devnet',
      programId: 'program-address',
      custodyMode: 'escrow',
      custodyVersion: 1,
      marketId: MARKET_ID,
      ownerPubkey: null,
      payload: { oracleEpoch: 4 },
      dueAtIso: NOW,
      maxAttempts: 8,
      nowIso: NOW,
    });

    client.response = { data: [relayerJob('leased')], error: null };
    await db.leaseRelayerJobs({ workerId: 'worker-a', nowIso: NOW, limit: 1 });

    client.response = { data: { ok: true, duplicate: false, state: 'signed' }, error: null };
    await db.recordRelayerSignedTransaction({
      jobId: JOB_ID,
      workerId: 'worker-a',
      leaseToken: LEASE_TOKEN,
      rawTransactionBase64: 'AQID',
      expectedSignature: 'expected-signature',
      lastValidBlockHeight: 999n,
      transactionMessageHashHex: HASH,
      nowIso: NOW,
    });

    client.response = { data: { ok: true, duplicate: false, state: 'submitted' }, error: null };
    await db.markRelayerSubmitted({
      jobId: JOB_ID,
      workerId: 'worker-a',
      leaseToken: LEASE_TOKEN,
      expectedSignature: 'expected-signature',
      nowIso: NOW,
    });

    expect(client.calls.map((call) => call.fn)).toEqual([
      'escrow_relayer_enqueue',
      'escrow_relayer_lease',
      'escrow_relayer_record_signed',
      'escrow_relayer_mark_submitted',
    ]);
    expect(client.calls[0]?.args).toMatchObject({
      p_custody_mode: 'escrow',
      p_custody_version: 1,
      p_lease_ms: 60_000,
    });
    expect(client.calls[2]?.args).toMatchObject({
      p_raw_transaction: 'AQID',
      p_expected_signature: 'expected-signature',
      p_last_valid_block_height: '999',
    });
  });

  it('treats placement relay work as a distinct durable job kind', async () => {
    const { client, db } = makeDb({
      data: { ok: true, created: true, job_id: JOB_ID },
      error: null,
    });
    await db.enqueueRelayerJob({
      kind: 'position_placement',
      idempotencyKey: `position:${MARKET_ID}:signature-a`,
      cluster: 'devnet',
      programId: PROGRAM_ID,
      custodyMode: 'escrow',
      custodyVersion: 1,
      marketId: MARKET_ID,
      ownerPubkey: 'owner-address',
      payload: { operation: 'place_position' },
      dueAtIso: NOW,
      maxAttempts: 8,
      nowIso: NOW,
    });
    client.response = { data: [relayerJob('leased', 'position_placement')], error: null };
    await expect(db.leaseRelayerJobs({ workerId: 'worker-a', nowIso: NOW, limit: 1 }))
      .resolves.toEqual([expect.objectContaining({ kind: 'position_placement' })]);
    expect(client.calls[0]?.args.p_kind).toBe('position_placement');
  });

  it('forwards both chain-history and blockhash-expiry evidence before re-signing', async () => {
    const { client, db } = makeDb({
      data: { ok: true, duplicate: false, state: 'retry_wait' },
      error: null,
    });

    await db.retryRelayerJob({
      jobId: JOB_ID,
      workerId: 'worker-a',
      leaseToken: LEASE_TOKEN,
      errorCode: 'not_landed',
      retryAtIso: LATER,
      confirmationUnknown: false,
      fullHistoryCheckedAtIso: NOW,
      currentBlockHeight: 1_000n,
      nowIso: NOW,
    });

    expect(client.calls).toEqual([{
      fn: 'escrow_relayer_retry',
      args: {
        p_job_id: JOB_ID,
        p_worker_id: 'worker-a',
        p_lease_token: LEASE_TOKEN,
        p_now: NOW,
        p_error_code: 'not_landed',
        p_retry_at: LATER,
        p_confirmation_unknown: false,
        p_full_history_checked_at: NOW,
        p_current_block_height: '1000',
      },
    }]);
  });

  it('fails closed on malformed payloads, unsafe identities, and raw database errors', async () => {
    const malformed = makeDb({ data: { ok: true, duplicate: 'yes', finalized: true }, error: null });
    await expect(malformed.db.recordPositionEvent({
      signature: 'position-signature',
      instructionIndex: 0,
      marketId: MARKET_ID,
      programId: 'program-address',
      positionPda: 'position-address',
      ownerPubkey: 'owner-address',
      lotNonce: 0n,
      eventKind: 'placed',
      side: 'back',
      asset: 'sol',
      amountAtomic: 1n,
      eventEpoch: 0n,
      state: 'pending',
      slot: 1n,
      blockTimeIso: null,
      commitment: 'confirmed',
      observedAtIso: NOW,
    })).rejects.toThrow('malformed RPC payload');

    const invalid = makeDb({ data: { ok: true, created: true }, error: null });
    expect(() => invalid.db.createSigningSession({
      tokenHashHex: 'not-a-hash',
      userId: Number.MAX_SAFE_INTEGER + 1,
      providerUserId: 'privy-user',
      providerWalletId: 'privy-wallet',
      ownerPubkey: 'owner-address',
      marketId: MARKET_ID,
      side: 'back',
      asset: 'sol',
      amountAtomic: 1n,
      lotNonce: 0n,
      eventEpoch: 0n,
      documentHashHex: HASH,
      transactionMessageHashHex: HASH,
      rawTransactionBase64: RAW_TRANSACTION_BASE64,
      authorization: authorization({
        side: 'back',
        amount: '1',
        expectedEventEpoch: '0',
        expectedLotNonce: '0',
      }),
      expiresAtIso: LATER,
      nowIso: NOW,
    })).toThrow();
    expect(invalid.client.calls).toHaveLength(0);

    const failed = makeDb({ data: null, error: { message: 'private database detail' } });
    await expect(failed.db.rewindConfirmedChain({
      cluster: 'devnet',
      programId: 'program-address',
      rewindSlot: 1n,
      nowIso: NOW,
    })).rejects.toThrow('db.escrow_rewind_confirmed_chain failed');
  });
});

describe('0024 escrow signing-session SQL contract', () => {
  const migration = readFileSync(new URL('../migrations/0024_escrow.sql', import.meta.url), 'utf8');
  const getSessionRpc = migration.slice(
    migration.indexOf('create function public.escrow_get_signing_session('),
    migration.indexOf('create function public.escrow_consume_signing_session('),
  );

  it('bounds and cross-binds the exact transaction presentation', () => {
    expect(migration).toContain('raw_transaction_base64        text not null check');
    expect(migration).toContain('length(raw_transaction_base64) between 4 and 4096');
    expect(migration).toContain('pg_column_size(p_payload) <= 8192');
    expect(migration).toContain('check (public.escrow_signing_authorization_valid(');
    expect(migration).toContain('and v_existing.raw_transaction_base64 = p_raw_transaction_base64');
    expect(migration).toContain('and v_existing.authorization_payload = p_authorization');
  });

  it('keeps lookup private, token-hash scoped, and atomically expires stale sessions', () => {
    expect(getSessionRpc).toContain('security definer');
    expect(getSessionRpc).toContain('where token_hash = v_token_hash');
    expect(getSessionRpc).toContain('for update;');
    expect(getSessionRpc).toContain("set state = 'expired', updated_at = p_now");
    expect(getSessionRpc).not.toContain("'token_hash'");
    expect(migration).toContain("p.proname like 'escrow_%'");
    expect(migration).toContain('revoke all privileges on function %I.%I(%s) from public, anon, authenticated');
    expect(migration).toContain('grant execute on function %I.%I(%s) to service_role');
    expect(migration).not.toMatch(/grant execute on function public\.escrow_get_signing_session[\s\S]*to (?:anon|authenticated)/i);
  });

  it('defines placement relay and exact private indexer reads', () => {
    expect(migration).toContain("'position_placement', 'position_activation'");
    expect(migration).toContain('create function public.escrow_get_chain_cursor(');
    expect(migration).toContain('create function public.escrow_get_market_link(');
    expect(migration).toContain("return jsonb_build_object('ok', false, 'code', 'genesis_mismatch')");
    expect(migration).toContain('check (last_finalized_slot <= last_confirmed_slot)');
    expect(migration).toContain("return jsonb_build_object('ok', false, 'code', 'noncanonical')");
    expect(migration).toContain("return jsonb_build_object('ok', false, 'code', 'custody_mismatch')");
    expect(migration).toContain("return jsonb_build_object('ok', false, 'code', 'ambiguous')");
    expect(migration).toContain("'market_id', v_link.market_id");
    expect(migration).toContain("'vault_pda', v_link.vault_pda");
    expect(migration).toContain("'oracle_epoch', v_link.oracle_epoch::text");
    expect(migration).toContain("'event_epoch', v_link.event_epoch::text");
  });
});

function relayerJob(
  state: 'leased',
  kind: 'settlement_submission' | 'position_placement' = 'settlement_submission',
): Record<string, unknown> {
  return {
    id: JOB_ID,
    kind,
    idempotency_key: `settle:${MARKET_ID}`,
    state,
    cluster: 'devnet',
    program_id: 'program-address',
    custody_mode: 'escrow',
    custody_version: 1,
    market_id: MARKET_ID,
    owner_pubkey: null,
    payload: { oracleEpoch: 4 },
    attempts: 1,
    max_attempts: 8,
    lease_duration_ms: 60_000,
    due_at: NOW,
    lease_owner: 'worker-a',
    lease_token: LEASE_TOKEN,
    lease_expires_at: LATER,
    expected_signature: null,
    raw_transaction: null,
    transaction_message_hash_hex: null,
    last_valid_block_height: null,
    error_code: null,
    created_at: NOW,
    updated_at: NOW,
  };
}
