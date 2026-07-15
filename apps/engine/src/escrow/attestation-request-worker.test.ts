import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import type { EscrowOracleAttestationProvider } from './attestation-signers.js';
import {
  attestationPayloadHash,
  createSignedAttestationPayload,
  createUnsignedAttestationPayload,
} from './attestation-request-payload.js';
import {
  createEscrowAttestationRequestService,
  type EscrowAttestationRequestDatabase,
} from './attestation-request-service.js';
import {
  createEscrowAttestationRequestWorker,
  type EscrowAttestationRequestRow,
  type EscrowAttestationWorkerDatabase,
} from './attestation-request-worker.js';
import { buildEscrowSettlementAttestation } from './event-attestations.js';

const NOW = '2026-07-15T12:00:00.000Z';
const LATER = '2026-07-15T12:01:30.000Z';
const MARKET_ID = '123e4567-e89b-12d3-a456-426614174000';
const PROGRAM = Keypair.generate().publicKey.toBase58();
const MARKET = Keypair.generate().publicKey.toBase58();
const CLAIM_SPECIFICATION_JSON = '{"claimType":"match_winner"}';
const policySigners = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
const policy = {
  oracleSetEpoch: 9n,
  signers: policySigners.map((value) => value.publicKey.toBase58()),
  threshold: 2,
} as const;

function unsigned() {
  const event = {
    kind: 'phase_change' as const, fixtureId: 77, seq: 20, tsMs: 100_000, receivedAtMs: 101_000,
    confirmed: true, phase: 'F' as const, minute: 90,
    score: {
      p1: { goals: 2, yellowCards: 0, redCards: 0, corners: 0 },
      p2: { goals: 1, yellowCards: 0, redCards: 0, corners: 0 },
      p1Goals90: 2, p2Goals90: 1,
    },
  };
  const attestation = buildEscrowSettlementAttestation({
    deployment: { genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', programId: PROGRAM },
    market: {
      marketId: MARKET_ID, marketPda: MARKET, marketDocumentHashHex: 'ab'.repeat(32),
      fixtureId: 77n, oracleSetEpoch: 9n, eventEpoch: 4n,
    },
    event, issuedAt: 1_700_000_000n, ttlSeconds: 300n,
    outcome: 'claim_won', decidingSequence: 20, evidenceSequences: [20],
  });
  return createUnsignedAttestationPayload({
    marketId: MARKET_ID, documentHashHex: 'ab'.repeat(32), eventEpoch: 4n,
    claimSpecificationJson: CLAIM_SPECIFICATION_JSON,
    replay: false, oraclePolicy: policy,
    request: { operation: 'settle_market', marketPda: MARKET, attestation },
  });
}

type EnqueueInput = Parameters<EscrowAttestationRequestDatabase['enqueueAttestationRequest']>[0];

class MemoryAttestationDb implements EscrowAttestationRequestDatabase, EscrowAttestationWorkerDatabase {
  input: EnqueueInput | null = null;
  signedPayload: Readonly<Record<string, unknown>> | null = null;
  signedPayloadHashHex: string | null = null;
  relayerJobId: string | null = null;
  completed = false;
  relayerComplete = false;
  completeCalls = 0;
  retries: string[] = [];
  leaseCount = 0;

  async enqueueAttestationRequest(input: EnqueueInput) {
    const created = this.input === null;
    if (this.input !== null && this.input.unsignedPayloadHashHex !== input.unsignedPayloadHashHex) {
      throw new TypeError('idempotency conflict');
    }
    this.input = input;
    return { ok: true as const, created, requestKey: input.requestKey };
  }

  async leaseAttestationRequests(input: { readonly workerId: string; readonly nowIso: string; readonly limit: number }) {
    if (this.completed || this.input === null || input.limit < 1) return [];
    this.leaseCount += 1;
    const value = this.input;
    const row: EscrowAttestationRequestRow = {
      requestKey: value.requestKey, operationKind: value.operationKind, state: 'leased',
      cluster: value.cluster, genesisHash: value.genesisHash, programId: value.programId,
      custodyVersion: value.custodyVersion, marketId: value.marketId, marketPda: value.marketPda,
      documentHashHex: value.documentHashHex, oracleEpoch: value.oracleEpoch, eventEpoch: value.eventEpoch,
      unsignedPayload: value.unsignedPayload, unsignedPayloadHashHex: value.unsignedPayloadHashHex,
      signedPayload: this.signedPayload, signedPayloadHashHex: this.signedPayloadHashHex,
      dueAtIso: value.dueAtIso, debounceUntilIso: value.debounceUntilIso,
      relayerJobId: this.relayerJobId, attempts: this.leaseCount, maxAttempts: value.maxAttempts,
      leaseDurationMs: value.leaseMs, leaseOwner: input.workerId,
      leaseToken: `00000000-0000-4000-8000-${String(this.leaseCount).padStart(12, '0')}`,
      leaseExpiresAtIso: LATER, errorCode: null, createdAtIso: NOW, updatedAtIso: input.nowIso,
      signedAtIso: this.signedPayload === null ? null : NOW,
      enqueuedAtIso: this.relayerJobId === null ? null : NOW,
      completedAtIso: null, failedAtIso: null,
    };
    return [row];
  }

  async recordAttestationSigned(input: Parameters<EscrowAttestationWorkerDatabase['recordAttestationSigned']>[0]) {
    this.signedPayload = input.signedPayload;
    this.signedPayloadHashHex = input.signedPayloadHashHex;
    return { ok: true as const, duplicate: false, state: 'signed' as const };
  }

  async markAttestationEnqueued(input: Parameters<EscrowAttestationWorkerDatabase['markAttestationEnqueued']>[0]) {
    this.relayerJobId = input.relayerJobId;
    return { ok: true as const, duplicate: false, state: 'enqueued' as const };
  }

  async completeAttestationRequest() {
    this.completeCalls += 1;
    if (!this.relayerComplete || this.relayerJobId === null) {
      return { ok: false as const, code: 'relayer_mismatch' as const };
    }
    this.completed = true;
    return { ok: true as const, duplicate: false, state: 'completed' as const };
  }

  async retryAttestationRequest(input: Parameters<EscrowAttestationWorkerDatabase['retryAttestationRequest']>[0]) {
    this.retries.push(input.errorCode);
    return { ok: true as const, duplicate: false, state: 'pending' as const };
  }
}

async function seededDb(debounceUntilIso: string | null = LATER) {
  const db = new MemoryAttestationDb();
  const service = createEscrowAttestationRequestService({
    db,
    deployment: {
      cluster: 'devnet', genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
      programId: PROGRAM, custodyVersion: 1,
    },
    maxAttempts: 8, leaseMs: 60_000, clock: () => NOW,
  });
  const payload = unsigned();
  const request = payload.request;
  if (request.operation !== 'settle_market') throw new TypeError('invalid settlement fixture');
  const result = await service.enqueue({
    marketId: MARKET_ID, documentHashHex: 'ab'.repeat(32), eventEpoch: 4n,
    claimSpecificationJson: CLAIM_SPECIFICATION_JSON,
    replay: false, oraclePolicy: policy,
    request: {
      operation: 'settle_market', marketPda: request.marketPda,
      attestation: buildEscrowSettlementAttestation({
        deployment: { genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', programId: PROGRAM },
        market: {
          marketId: MARKET_ID, marketPda: MARKET, marketDocumentHashHex: 'ab'.repeat(32),
          fixtureId: 77n, oracleSetEpoch: 9n, eventEpoch: 4n,
        },
        event: {
          kind: 'phase_change', fixtureId: 77, seq: 20, tsMs: 100_000, receivedAtMs: 101_000,
          confirmed: true, phase: 'F', minute: 90,
          score: {
            p1: { goals: 2, yellowCards: 0, redCards: 0, corners: 0 },
            p2: { goals: 1, yellowCards: 0, redCards: 0, corners: 0 },
            p1Goals90: 2, p2Goals90: 1,
          },
        },
        issuedAt: 1_700_000_000n, ttlSeconds: 300n,
        outcome: 'claim_won', decidingSequence: 20, evidenceSequences: [20],
      }),
    },
    dueAtIso: LATER, debounceUntilIso,
  });
  return { db, result };
}

function oracle(calls: { value: number }, fail = false): EscrowOracleAttestationProvider {
  return {
    async availableSigners() { return policy.signers; },
    async sign() {
      calls.value += 1;
      if (fail) throw new TypeError('endpoint unavailable');
      return policySigners.slice(0, 2).map((value) => ({
        publicKey: value.publicKey.toBytes(), signature: new Uint8Array(64),
      }));
    },
  };
}

function worker(input: {
  readonly db: MemoryAttestationDb;
  readonly oracle: EscrowOracleAttestationProvider;
  readonly queue: Map<string, string>;
  readonly validate?: () => Promise<'current' | 'obsolete'>;
}) {
  const enqueue = async () => {
    const key = input.db.input?.requestKey;
    if (key === undefined) throw new TypeError('missing request');
    const existing = input.queue.get(key);
    const jobId = existing ?? '123e4567-e89b-12d3-a456-426614174999';
    input.queue.set(key, jobId);
    return { kind: 'enqueued' as const, jobId };
  };
  return createEscrowAttestationRequestWorker({
    db: input.db, oracle: input.oracle,
    control: { enqueue }, recovery: { enqueue }, workerId: 'worker-a',
    retryAt: () => LATER, nextCheckAt: () => LATER,
    validate: input.validate === undefined ? undefined : async () => input.validate?.() ?? 'current',
  });
}

describe('durable attestation request worker', () => {
  it('normalizes an immediate request to a non-null durable debounce boundary', async () => {
    const { db } = await seededDb(null);

    expect(db.input?.dueAtIso).toBe(LATER);
    expect(db.input?.debounceUntilIso).toBe(LATER);
  });

  it('deduplicates persisted intent before any signing occurs', async () => {
    const { db, result } = await seededDb();
    const original = db.input;
    if (original === null) throw new TypeError('missing request fixture');

    await expect(db.enqueueAttestationRequest(original)).resolves.toMatchObject({ created: false });
    expect(result.requestKey).toBe(original.requestKey);
    expect(original.operationKind).toBe('settle');
  });

  it('rejects a substituted request key or encoded deployment before oracle signing', async () => {
    const keySubstitution = await seededDb();
    if (keySubstitution.db.input === null) throw new TypeError('missing request fixture');
    keySubstitution.db.input = { ...keySubstitution.db.input, requestKey: '00'.repeat(32) };
    const calls = { value: 0 };

    await expect(worker({
      db: keySubstitution.db, oracle: oracle(calls), queue: new Map(),
    }).runOnce(LATER, 1)).resolves.toEqual([expect.objectContaining({
      kind: 'retrying', errorCode: 'invalid_payload',
    })]);
    expect(calls.value).toBe(0);

    const networkSubstitution = await seededDb();
    if (networkSubstitution.db.input === null) throw new TypeError('missing request fixture');
    networkSubstitution.db.input = { ...networkSubstitution.db.input, genesisHash: '11111111111111111111111111111111' };
    await worker({ db: networkSubstitution.db, oracle: oracle(calls), queue: new Map() }).runOnce(LATER, 1);
    expect(networkSubstitution.db.retries).toEqual(['invalid_payload']);
    expect(calls.value).toBe(0);
  });

  it('signs, persists, and leaves a new relayer handoff enqueued', async () => {
    const { db } = await seededDb();
    const calls = { value: 0 };
    const queue = new Map<string, string>();

    await expect(worker({ db, oracle: oracle(calls), queue }).runOnce(LATER, 10))
      .resolves.toEqual([expect.objectContaining({ kind: 'enqueued' })]);
    expect(calls.value).toBe(1);
    expect(queue.size).toBe(1);
    expect(db.completed).toBe(false);
    expect(db.completeCalls).toBe(0);
    expect(db.retries).toEqual([]);
  });

  it('recovers every persisted crash handoff without changing canonical signatures', async () => {
    const { db } = await seededDb();
    const payload = db.input?.unsignedPayload;
    const payloadHash = db.input?.unsignedPayloadHashHex;
    if (payload === undefined || payloadHash === undefined) throw new TypeError('missing request fixture');
    const calls = { value: 0 };
    const signed = createSignedAttestationPayload(payloadHash, policySigners.slice(0, 2).map((value) => ({
      publicKey: value.publicKey.toBytes(), signature: new Uint8Array(64),
    })));
    db.signedPayload = signed;
    db.signedPayloadHashHex = attestationPayloadHash(signed);
    const queue = new Map<string, string>();
    const requestKey = db.input?.requestKey;
    if (requestKey === undefined) throw new TypeError('missing request key');
    queue.set(requestKey, '123e4567-e89b-12d3-a456-426614174999');

    await worker({ db, oracle: oracle(calls), queue }).runOnce(LATER, 1);

    expect(calls.value).toBe(0);
    expect(queue.size).toBe(1);
    expect(db.relayerJobId).toBe('123e4567-e89b-12d3-a456-426614174999');
    expect(db.completed).toBe(false);
    expect(db.completeCalls).toBe(0);
  });

  it('retries a marked handoff until the relayer job completes without transition rejection', async () => {
    const { db } = await seededDb();
    db.relayerJobId = '123e4567-e89b-12d3-a456-426614174999';
    const calls = { value: 0 };
    const queue = new Map<string, string>();

    await expect(worker({ db, oracle: oracle(calls), queue }).runOnce(LATER, 1))
      .resolves.toEqual([expect.objectContaining({
        kind: 'retrying', errorCode: 'relayer_not_complete_or_mismatch',
      })]);

    expect(calls.value).toBe(0);
    expect(queue.size).toBe(0);
    expect(db.completed).toBe(false);
    expect(db.completeCalls).toBe(1);
    expect(db.retries).toEqual(['relayer_not_complete_or_mismatch']);
  });

  it('completes a marked handoff on a later lease after the relayer job completes', async () => {
    const { db } = await seededDb();
    db.relayerJobId = '123e4567-e89b-12d3-a456-426614174999';
    db.relayerComplete = true;
    const calls = { value: 0 };

    await expect(worker({ db, oracle: oracle(calls), queue: new Map() }).runOnce(LATER, 1))
      .resolves.toEqual([expect.objectContaining({ kind: 'completed' })]);

    expect(calls.value).toBe(0);
    expect(db.completed).toBe(true);
    expect(db.completeCalls).toBe(1);
  });

  it('retries signer outage and fails closed for obsolete reordered terminal intent without signing', async () => {
    const first = await seededDb();
    const calls = { value: 0 };
    await expect(worker({ db: first.db, oracle: oracle(calls, true), queue: new Map() }).runOnce(LATER, 1))
      .resolves.toEqual([expect.objectContaining({ kind: 'retrying' })]);
    expect(first.db.retries).toEqual(['attestation_processing_failed']);

    const second = await seededDb();
    await expect(worker({
      db: second.db, oracle: oracle(calls), queue: new Map(), validate: async () => 'obsolete',
    }).runOnce(LATER, 1)).resolves.toEqual([expect.objectContaining({
      kind: 'retrying', errorCode: 'attestation_request_obsolete',
    })]);
    expect(second.db.completed).toBe(false);
    expect(second.db.retries).toEqual(['attestation_request_obsolete']);
    expect(calls.value).toBe(1);
  });
});
