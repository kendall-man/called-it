import type { EscrowDb } from '@calledit/db';
import { deriveMarketPda } from '@calledit/escrow-sdk';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  createEscrowPlacementService,
  EscrowPlacementError,
  type CreateDurableEscrowPlacementSessionInput,
  type EscrowPlacementDatabase,
  type EscrowPlacementMarket,
} from './placement-service.js';

const MARKET_ID = '123e4567-e89b-12d3-a456-426614174000';
const BLOCKHASH = '11111111111111111111111111111111';
const NOW_ISO = '2023-11-14T22:13:20.000Z';
const NOW_UNIX = 1_700_000_000n;
const GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

function setup(
  asset: 'sol' | 'usdc',
  overrides: Partial<EscrowPlacementMarket> = {},
  observedGenesisHash = GENESIS_HASH,
  linkOverrides: Readonly<Record<string, unknown>> = {},
) {
  const program = Keypair.generate();
  const sponsor = Keypair.generate();
  const owner = Keypair.generate();
  const mint = Keypair.generate();
  const marketPda = deriveMarketPda(program.publicKey, MARKET_ID).address;
  const market: EscrowPlacementMarket = {
    custodyMode: 'escrow',
    ownerProgramId: program.publicKey.toBase58(),
    marketPda,
    marketId: MARKET_ID,
    documentHashHex: 'ab'.repeat(32),
    asset,
    tokenMint: asset === 'usdc' ? mint.publicKey.toBase58() : null,
    ratioMilli: 1_500,
    eventEpoch: 4n,
    oracleSetEpoch: 9n,
    replay: false,
    positionCutoffTimestamp: NOW_UNIX + 3_600n,
    state: 'open',
    ...overrides,
  };
  const sessions: CreateDurableEscrowPlacementSessionInput[] = [];
  const consumed: Parameters<EscrowDb['consumeSigningSession']>[0][] = [];
  const jobs: Parameters<EscrowPlacementDatabase['enqueueRelayerJob']>[0][] = [];
  const jobKeys = new Set<string>();
  let consumedSignature: string | null = null;
  const db: EscrowPlacementDatabase = {
    async createSigningSession(input) {
      sessions.push(input);
      return { ok: true, created: true };
    },
    async getSigningSession(input) {
      const expected = sessions.find((session) => session.tokenHashHex === input.tokenHashHex);
      if (expected === undefined) return { ok: false, code: 'session_not_found' };
      if (input.nowIso > expected.expiresAtIso) return { ok: false, code: 'session_expired' };
      return {
        ok: true,
        ownerPubkey: expected.ownerPubkey,
        rawTransactionBase64: expected.rawTransactionBase64,
        authorization: expected.authorization,
      };
    },
    async getMarketLink() {
      return {
        ok: true,
        found: true,
        marketId: market.marketId,
        custodyMode: 'escrow',
        custodyVersion: 1,
        cluster: 'devnet',
        genesisHash: GENESIS_HASH,
        programId: program.publicKey.toBase58(),
        marketPda,
        vaultPda: 'vault-a',
        asset: market.asset,
        mintPubkey: market.asset === 'usdc' ? market.tokenMint : null,
        documentHashHex: market.documentHashHex,
        oracleEpoch: market.oracleSetEpoch,
        eventEpoch: market.eventEpoch,
        ratioMilli: BigInt(market.ratioMilli),
        chainState: 'open',
        commitment: 'finalized',
        projectionStale: false,
        ...linkOverrides,
      };
    },
    async consumeSigningSession(input) {
      consumed.push(input);
      const expected = sessions[0];
      if (expected === undefined || input.transactionMessageHashHex !== expected.transactionMessageHashHex) {
        return { ok: false, code: 'binding_mismatch' };
      }
      if (input.nowIso > expected.expiresAtIso) return { ok: false, code: 'session_expired' };
      if (consumedSignature !== null) {
        return consumedSignature === input.transactionSignature
          ? { ok: true, duplicate: true, state: 'consumed' }
          : { ok: false, code: 'session_consumed' };
      }
      consumedSignature = input.transactionSignature;
      return { ok: true, duplicate: false, state: 'consumed' };
    },
    async consumeSigningSessionAndEnqueuePlacement(input) {
      consumed.push(input);
      const expected = sessions[0];
      if (expected === undefined || input.transactionMessageHashHex !== expected.transactionMessageHashHex) {
        return { ok: false, code: 'binding_mismatch' };
      }
      if (input.nowIso > expected.expiresAtIso) {
        return { ok: false, code: 'session_expired' };
      }
      if (consumedSignature !== null) {
        if (consumedSignature !== input.transactionSignature) {
          return { ok: false, code: 'session_consumed' };
        }
        return {
          ok: true,
          duplicate: true,
          state: 'consumed',
          jobCreated: false,
          jobId: 'job-a',
        };
      }
      consumedSignature = input.transactionSignature;
      const job = {
        kind: 'position_placement',
        ...input,
      } as const;
      jobs.push(job);
      const created = !jobKeys.has(input.idempotencyKey);
      jobKeys.add(input.idempotencyKey);
      return {
        ok: true,
        duplicate: false,
        state: 'consumed',
        jobCreated: created,
        jobId: 'job-a',
      };
    },
    async enqueueRelayerJob(input) {
      jobs.push(input);
      const created = !jobKeys.has(input.idempotencyKey);
      jobKeys.add(input.idempotencyKey);
      return { ok: true, created, jobId: 'job-a' };
    },
  };
  let clock = { unix: NOW_UNIX, iso: NOW_ISO };
  let intakeReady = true;
  const serviceOptions = {
    db,
    sponsor,
    deployment: {
      cluster: 'devnet' as const,
      genesisHash: GENESIS_HASH,
      programId: program.publicKey.toBase58(),
      canonicalUsdcMint: mint.publicKey.toBase58(),
      oracleSetEpoch: 9n,
      custodyVersion: 1,
      minimumSolPosition: 1n,
      maximumSolPosition: 1_000_000_000n,
      minimumUsdcPosition: 1n,
      maximumUsdcPosition: 1_000_000_000n,
      allowedGroupIds: [-100_123],
    },
    chain: {
      readMarket: async () => market,
      readPosition: async () => null,
      latestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 900n }),
      blockHeight: async () => 800n,
      genesisHash: async () => observedGenesisHash,
      isBlockhashValid: async (blockhash: string) => blockhash === BLOCKHASH,
    },
    readiness: async () => intakeReady
      ? { status: 'ready' as const, reasons: [] as const }
      : { status: 'not_ready' as const, reasons: ['program_paused'] as const },
    clock: () => clock,
    tokenBytes: () => Uint8Array.from({ length: 32 }, (_, index) => index + 1),
  };
  const service = createEscrowPlacementService(serviceOptions);
  return {
    service,
    owner,
    program,
    market,
    sessions,
    consumed,
    jobs,
    restartService: () => createEscrowPlacementService(serviceOptions),
    blockIntake: () => { intakeReady = false; },
    advanceClock: () => { clock = { unix: NOW_UNIX + 301n, iso: '2023-11-14T22:18:21.000Z' }; },
  };
}

const identity = (owner: Keypair) => ({
  groupId: -100_123,
  telegramUserId: 42,
  privyUserId: 'privy-user-42',
  privyWalletId: 'privy-wallet-42',
  ownerPubkey: owner.publicKey.toBase58(),
});

describe('escrow placement signing sessions', () => {
  it.each(['sol', 'usdc'] as const)('builds and persists exact sponsored %s terms', async (asset) => {
    // Given a chain-verified escrow market and Privy wallet
    const fixture = setup(asset);

    // When a short-lived placement session is created
    const result = await fixture.service.create({
      ...identity(fixture.owner), marketId: MARKET_ID, side: 'back', amountAtomic: 25n, ttlSeconds: 300,
    });

    // Then the DB binding contains every economic field and the user has not yet signed
    expect(result.kind).toBe('created');
    if (result.kind !== 'created') return;
    expect(fixture.sessions[0]).toMatchObject({
      userId: 42, ownerPubkey: fixture.owner.publicKey.toBase58(), marketId: MARKET_ID,
      side: 'back', asset, amountAtomic: 25n, lotNonce: 0n, eventEpoch: 4n,
      documentHashHex: 'ab'.repeat(32),
    });
    const transaction = VersionedTransaction.deserialize(Buffer.from(result.rawTransactionBase64, 'base64'));
    expect(transaction.signatures[1]?.every((byte) => byte === 0)).toBe(true);
  });

  it('presents exact sponsor-signed bytes from only the opaque token after restart', async () => {
    // Given Telegram created a session and only the durable artifact store survives
    const fixture = setup('usdc');
    const created = await fixture.service.create({
      ...identity(fixture.owner), marketId: MARKET_ID, side: 'doubt', amountAtomic: 31n, ttlSeconds: 300,
    });
    if (created.kind !== 'created') throw new Error('expected created session');

    // When a separate signing process resolves the opaque bearer token
    const presented = await fixture.restartService().present(created.token);

    // Then it receives the identical transaction and server-pinned authorization
    expect(presented).toMatchObject({
      kind: 'found', schemaVersion: 1, rawTransactionBase64: created.rawTransactionBase64,
      authorization: {
        schemaVersion: 1, amount: '31', expectedRatioMilli: '1500',
        expectedEventEpoch: '4', expectedLotNonce: '0',
        expiresAt: String(NOW_UNIX + 300n), lastValidBlockHeight: '900',
      },
    });
    expect(() => JSON.stringify(presented)).not.toThrow();
    await expect(fixture.restartService().present('unknown-token')).resolves.toEqual({
      kind: 'rejected', code: 'session_not_found',
    });
  });

  it('handles duplicate signed callbacks across a restart without duplicate economic jobs', async () => {
    // Given one sponsor-signed session completed by the user wallet
    const fixture = setup('sol');
    const created = await fixture.service.create({
      ...identity(fixture.owner), marketId: MARKET_ID, side: 'back', amountAtomic: 25n, ttlSeconds: 300,
    });
    if (created.kind !== 'created') throw new Error('expected created session');
    const transaction = VersionedTransaction.deserialize(Buffer.from(created.rawTransactionBase64, 'base64'));
    transaction.sign([fixture.owner]);
    const rawTransactionBase64 = Buffer.from(transaction.serialize()).toString('base64');
    const callback = {
      ...identity(fixture.owner), marketId: MARKET_ID, token: created.token,
      rawTransactionBase64,
    };

    // When the callback is delivered twice, including after process-local state is gone
    const first = await fixture.service.accept(callback);
    const duplicate = await fixture.service.accept(callback);

    // Then 0024 idempotency preserves one signed intent and reports the replay
    expect(first).toMatchObject({ kind: 'accepted', duplicate: false, jobCreated: true });
    expect(duplicate).toMatchObject({ kind: 'accepted', duplicate: true, jobCreated: false });
    expect(fixture.jobs[0]?.payload).toMatchObject({
      operation: 'place_position', rawTransactionBase64, lastValidBlockHeight: '900',
    });
    expect(fixture.jobs[0]?.kind).toBe('position_placement');
    expect(fixture.jobs[0]?.leaseMs).toBe(5_000);
    expect(fixture.jobs[0]?.maxAttempts).toBe(120);
    expect((fixture.jobs[0]?.leaseMs ?? 0) * (fixture.jobs[0]?.maxAttempts ?? 0)).toBe(600_000);
    expect(new Set(fixture.jobs.map((job) => job.idempotencyKey)).size).toBe(1);
  });

  it('rechecks intake readiness before consuming a user-signed position', async () => {
    const fixture = setup('sol');
    const created = await fixture.service.create({
      ...identity(fixture.owner), marketId: MARKET_ID, side: 'back', amountAtomic: 25n, ttlSeconds: 300,
    });
    if (created.kind !== 'created') throw new Error('expected created session');
    const transaction = VersionedTransaction.deserialize(Buffer.from(created.rawTransactionBase64, 'base64'));
    transaction.sign([fixture.owner]);
    fixture.blockIntake();

    await expect(fixture.service.accept({
      ...identity(fixture.owner), marketId: MARKET_ID, token: created.token,
      rawTransactionBase64: Buffer.from(transaction.serialize()).toString('base64'),
    })).rejects.toMatchObject({ code: 'market_unavailable' });
    expect(fixture.consumed).toHaveLength(0);
    expect(fixture.jobs).toHaveLength(0);
  });

  it('rejects stale sessions, tampered messages, and custody substitution', async () => {
    // Given valid bytes whose session later expires
    const stale = setup('sol');
    const created = await stale.service.create({
      ...identity(stale.owner), marketId: MARKET_ID, side: 'back', amountAtomic: 25n, ttlSeconds: 300,
    });
    if (created.kind !== 'created') throw new Error('expected created session');
    const transaction = VersionedTransaction.deserialize(Buffer.from(created.rawTransactionBase64, 'base64'));
    transaction.sign([stale.owner]);
    const raw = Buffer.from(transaction.serialize()).toString('base64');
    stale.advanceClock();

    // When stale, tampered, or legacy-routed requests arrive, then none reaches relay
    await expect(stale.service.accept({
      ...identity(stale.owner), marketId: MARKET_ID, token: created.token,
      rawTransactionBase64: raw,
    })).resolves.toEqual({ kind: 'rejected', code: 'session_expired' });
    const tampered = setup('sol');
    const tamperedCreated = await tampered.service.create({
      ...identity(tampered.owner), marketId: MARKET_ID, side: 'back', amountAtomic: 25n, ttlSeconds: 300,
    });
    if (tamperedCreated.kind !== 'created') throw new Error('expected created session');
    const tamperedTransaction = VersionedTransaction.deserialize(
      Buffer.from(tamperedCreated.rawTransactionBase64, 'base64'),
    );
    tamperedTransaction.sign([tampered.owner]);
    const ownerSignature = tamperedTransaction.signatures[1];
    if (ownerSignature === undefined) throw new Error('expected owner signature');
    ownerSignature[0] = (ownerSignature[0] ?? 0) ^ 1;
    const tamperedRaw = Buffer.from(tamperedTransaction.serialize()).toString('base64');
    await expect(tampered.service.accept({
      ...identity(tampered.owner), marketId: MARKET_ID, token: tamperedCreated.token,
      rawTransactionBase64: tamperedRaw,
    })).rejects.toBeInstanceOf(Error);
    const legacy = setup('sol', { custodyMode: 'legacy' });
    await expect(legacy.service.create({
      ...identity(legacy.owner), marketId: MARKET_ID, side: 'back', amountAtomic: 25n, ttlSeconds: 300,
    })).rejects.toBeInstanceOf(EscrowPlacementError);
  });

  it.each([
    { field: 'ownerProgramId', value: Keypair.generate().publicKey.toBase58() },
    { field: 'tokenMint', value: Keypair.generate().publicKey.toBase58() },
  ] as const)('fails closed for a wrong $field', async ({ field, value }) => {
    // Given a chain account that does not match configured deployment identity
    const fixture = setup('usdc', { [field]: value });

    // When placement is requested, then no signing session is issued
    await expect(fixture.service.create({
      ...identity(fixture.owner), marketId: MARKET_ID, side: 'back', amountAtomic: 25n, ttlSeconds: 300,
    })).rejects.toBeInstanceOf(EscrowPlacementError);
    expect(fixture.sessions).toHaveLength(0);
  });

  it('uses the market-pinned oracle epoch after the deployment epoch rotates', async () => {
    const fixture = setup('sol', { oracleSetEpoch: 8n });

    await expect(fixture.service.create({
      ...identity(fixture.owner), marketId: MARKET_ID, side: 'back', amountAtomic: 25n, ttlSeconds: 300,
    })).resolves.toMatchObject({ kind: 'created' });
    expect(fixture.sessions).toHaveLength(1);
  });

  it('rejects a stale or mismatched historical market link', async () => {
    const fixture = setup('sol', {}, GENESIS_HASH, { oracleEpoch: 8n });

    await expect(fixture.service.create({
      ...identity(fixture.owner), marketId: MARKET_ID, side: 'back', amountAtomic: 25n, ttlSeconds: 300,
    })).rejects.toMatchObject({ code: 'market_identity_mismatch' });
    expect(fixture.sessions).toHaveLength(0);
  });

  it('uses the same capped user-signed escrow path for an isolated replay market', async () => {
    const fixture = setup('sol', { replay: true });

    await expect(fixture.service.create({
      ...identity(fixture.owner), marketId: MARKET_ID, side: 'back', amountAtomic: 25n, ttlSeconds: 300,
    })).resolves.toMatchObject({ kind: 'created' });
    expect(fixture.sessions).toHaveLength(1);
    expect(fixture.jobs).toHaveLength(0);

    await expect(fixture.service.create({
      ...identity(fixture.owner), marketId: MARKET_ID, side: 'back', amountAtomic: 1_000_000_001n, ttlSeconds: 300,
    })).rejects.toMatchObject({ code: 'amount_out_of_range' });
  });

  it('uses wall-clock expiry for a replay signing session', async () => {
    // Completed-match replays advance virtual match time much faster than real time.
    const fixture = setup('sol', {
      replay: true,
      positionCutoffTimestamp: NOW_UNIX + 60n,
    });

    const result = await fixture.service.create({
      ...identity(fixture.owner), marketId: MARKET_ID, side: 'back', amountAtomic: 25n, ttlSeconds: 300,
    });

    expect(result).toMatchObject({
      kind: 'created',
      authorization: { expiresAt: NOW_UNIX + 300n },
    });
    expect(fixture.sessions[0]?.expiresAtIso).toBe('2023-11-14T22:18:20.000Z');
  });

  it('keeps a live signing session capped at the market cutoff', async () => {
    const fixture = setup('sol', {
      replay: false,
      positionCutoffTimestamp: NOW_UNIX + 60n,
    });

    const result = await fixture.service.create({
      ...identity(fixture.owner), marketId: MARKET_ID, side: 'back', amountAtomic: 25n, ttlSeconds: 300,
    });

    expect(result).toMatchObject({
      kind: 'created',
      authorization: { expiresAt: NOW_UNIX + 60n },
    });
    expect(fixture.sessions[0]?.expiresAtIso).toBe('2023-11-14T22:14:20.000Z');
  });

  it('fails closed outside the configured escrow group allowlist', async () => {
    const fixture = setup('sol', { replay: true });

    await expect(fixture.service.create({
      ...identity(fixture.owner), groupId: -100_999, marketId: MARKET_ID,
      side: 'back', amountAtomic: 25n, ttlSeconds: 300,
    })).rejects.toMatchObject({ code: 'group_not_allowed' });
    expect(fixture.sessions).toHaveLength(0);
  });

  it('fails closed on the wrong RPC network', async () => {
    // Given an RPC endpoint for a different genesis hash
    const fixture = setup('sol', {}, 'wrong-cluster-genesis');

    // When placement is requested, then no transaction is prepared
    await expect(fixture.service.create({
      ...identity(fixture.owner), marketId: MARKET_ID, side: 'back', amountAtomic: 25n, ttlSeconds: 300,
    })).rejects.toMatchObject({ code: 'network_mismatch' });
    expect(fixture.sessions).toHaveLength(0);
  });
});
