import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bytesToHex,
  canonicalJson,
  encodeSettlementAttestationV1,
  encodeVoidAttestationV1,
  escrowEvidenceSequenceCommitmentV2,
  normalizedEscrowEvidenceHashV2,
  settlementEvidenceHashV2,
  type MarketAccount,
  type OracleSetAccount,
  type PositionInvalidationAttestationV1,
  type PositionLotAccount,
  type ProtocolConfigAccount,
  type SettlementAttestationV1,
  type VoidAttestationV1,
} from '@calledit/escrow-sdk';
import type { MatchEvent, MarketSpec } from '@calledit/market-engine';
import { base58Decode, base58Encode } from '@calledit/solana';
import { Keypair } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseOracleSigningEnvelope } from './contracts.js';
import { loadOracleSignerEnv, type OracleSignerEnv } from './env.js';
import { OracleSignatureJournal } from './journal.js';
import { createOracleSignerServer } from './server.js';
import { OracleAttestationVerifier } from './verifier.js';

const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const PROGRAM = Keypair.generate().publicKey;
const MARKET = Keypair.generate().publicKey;
const NOW_MS = 1_800_000_000_000;
const CLAIM: MarketSpec = {
  claimType: 'match_winner', fixtureId: 77,
  entityRef: { kind: 'team', participant: 1, name: 'Home' },
  comparator: 'gte', threshold: 1, period: 'FT_90', trustTier: 'oracle_resolved',
};
const CLAIM_JSON = canonicalJson(CLAIM);
const THRESHOLD_CLAIM: MarketSpec = {
  ...CLAIM,
  claimType: 'team_scores_n',
};
const THRESHOLD_CLAIM_JSON = canonicalJson(THRESHOLD_CLAIM);
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const EVENT: MatchEvent = {
  kind: 'phase_change', fixtureId: 77, seq: 20, tsMs: NOW_MS - 20_000, receivedAtMs: NOW_MS - 19_000,
  confirmed: true, phase: 'F', minute: 90,
  score: {
    p1: { goals: 2, yellowCards: 0, redCards: 0, corners: 3 },
    p2: { goals: 1, yellowCards: 1, redCards: 0, corners: 2 },
    p1Goals90: 2, p2Goals90: 1,
  },
};
const POST_EVENT: MatchEvent = { ...EVENT, phase: 'POST' };
const LOT = Keypair.generate().publicKey;
const ACTIVATION_TIMESTAMP = BigInt(Math.floor(NOW_MS / 1_000));
const PRICE_MOVING_EVENT: MatchEvent = {
  ...EVENT,
  kind: 'goal',
  seq: 21,
  tsMs: Number((ACTIVATION_TIMESTAMP - 1n) * 1_000n),
  phase: 'H2',
  minute: 60,
  detail: { participant: 1 },
};

function environmentSource(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PORT: '8080',
    ORACLE_SIGNER_NETWORK: 'devnet',
    ORACLE_SIGNER_ALLOW_MAINNET: 'false',
    ORACLE_SIGNER_BEARER_TOKEN: 't'.repeat(32),
    ORACLE_SIGNER_KEYPAIR_B58: base58Encode(Keypair.generate().secretKey),
    ORACLE_SIGNER_JOURNAL_PATH: '/tmp/test-journal',
    SOLANA_RPC_URL: 'https://rpc.example.test',
    ESCROW_PROGRAM_ID: PROGRAM.toBase58(),
    ESCROW_GENESIS_HASH: GENESIS,
    ESCROW_ORACLE_SET_EPOCH: '9',
    TXLINE_API_BASE: 'https://txline.example.test',
    TXLINE_GUEST_JWT: 'guest',
    TXLINE_API_TOKEN: 'token',
    ORACLE_SIGNER_CLOCK_SKEW_SECONDS: '30',
    ...overrides,
  };
}

function environment(signer = Keypair.generate()): OracleSignerEnv {
  return {
    PORT: 8080, ORACLE_SIGNER_NETWORK: 'devnet', ORACLE_SIGNER_ALLOW_MAINNET: 'false',
    ORACLE_SIGNER_BEARER_TOKEN: 't'.repeat(32), ORACLE_SIGNER_JOURNAL_PATH: '/tmp/test-journal',
    SOLANA_RPC_URL: 'https://rpc.example.test', ESCROW_PROGRAM_ID: PROGRAM.toBase58(),
    ESCROW_GENESIS_HASH: GENESIS, ESCROW_ORACLE_SET_EPOCH: 9n,
    TXLINE_API_BASE: 'https://txline.example.test', TXLINE_GUEST_JWT: 'guest', TXLINE_API_TOKEN: 'token',
    ORACLE_SIGNER_CLOCK_SKEW_SECONDS: 30, signer,
  };
}

function attestation(overrides: Partial<SettlementAttestationV1> = {}): SettlementAttestationV1 {
  const commitment = escrowEvidenceSequenceCommitmentV2(77, [20]);
  const root = normalizedEscrowEvidenceHashV2(EVENT);
  return {
    clusterGenesisHash: base58Decode(GENESIS), escrowProgramId: PROGRAM.toBytes(), marketPda: MARKET.toBytes(),
    marketDocumentHash: new Uint8Array(32).fill(0xab), fixtureId: 77n, oracleSetEpoch: 9n,
    issuedAt: BigInt(Math.floor(NOW_MS / 1_000) - 30), expiresAt: BigInt(Math.floor(NOW_MS / 1_000) + 300),
    evidenceHash: settlementEvidenceHashV2(commitment, root), outcome: 'claim_won', decidingSequence: 20n,
    terminalPhase: 'F', regulationScore: { home: 2, away: 1 }, fullMatchScore: { home: 2, away: 1 },
    evidenceSequenceCommitment: commitment, normalizedEvidenceRoot: root,
    ...overrides,
  };
}

function voidAttestation(event = POST_EVENT, overrides: Partial<VoidAttestationV1> = {}): VoidAttestationV1 {
  const base = attestation();
  return {
    clusterGenesisHash: base.clusterGenesisHash,
    escrowProgramId: base.escrowProgramId,
    marketPda: base.marketPda,
    marketDocumentHash: base.marketDocumentHash,
    fixtureId: base.fixtureId,
    oracleSetEpoch: base.oracleSetEpoch,
    issuedAt: base.issuedAt,
    expiresAt: base.expiresAt,
    evidenceHash: normalizedEscrowEvidenceHashV2(event),
    reason: 'undecidable',
    decidingSequence: BigInt(event.seq),
    ...overrides,
  };
}

function invalidationAttestation(
  event = PRICE_MOVING_EVENT,
  overrides: Partial<PositionInvalidationAttestationV1> = {},
): PositionInvalidationAttestationV1 {
  const base = attestation();
  return {
    clusterGenesisHash: base.clusterGenesisHash,
    escrowProgramId: base.escrowProgramId,
    marketPda: base.marketPda,
    marketDocumentHash: base.marketDocumentHash,
    fixtureId: base.fixtureId,
    oracleSetEpoch: base.oracleSetEpoch,
    issuedAt: base.issuedAt,
    expiresAt: base.expiresAt,
    evidenceHash: normalizedEscrowEvidenceHashV2(event),
    positionLotPda: LOT.toBytes(),
    lotNonce: 4n,
    observedEventEpoch: 0n,
    invalidatedEventEpoch: 1n,
    decidingSequence: BigInt(event.seq),
    ...overrides,
  };
}

function market(
  value: SettlementAttestationV1 | VoidAttestationV1,
  claimSpecificationJson = CLAIM_JSON,
): MarketAccount {
  return {
    version: 1, bump: 1, marketUuid: '123e4567-e89b-12d3-a456-426614174000', fixtureId: 77n,
    claimSpecificationHash: Uint8Array.from(createHash('sha256').update(claimSpecificationJson).digest()),
    displayTermsHash: new Uint8Array(32), oddsMessageHash: new Uint8Array(32),
    marketDocumentHash: value.marketDocumentHash, quoteTimestamp: 1n, probabilityPpm: 500_000,
    ratioMilli: 2_000, asset: 'sol', tokenMint: null, feeBps: 0, state: 'open', replay: true,
    residualRecipient: Keypair.generate().publicKey.toBase58(), createdTimestamp: 1n,
    inPlayStartTimestamp: 2n, activationDelaySeconds: 150n, positionCutoffTimestamp: 3n,
    resolutionDeadline: 4n, oracleSetEpoch: 9n, eventEpoch: 0n,
    activeBackTotal: 0n, activeDoubtTotal: 0n, pendingBackTotal: 0n, pendingDoubtTotal: 0n,
    finalMatchedBackTotal: 0n, finalMatchedDoubtTotal: 0n, finalForfeitedTotal: 0n,
    settlementProcessedPositionCount: 0n, settlementOutcome: null, settlementEvidenceHash: null,
    positionCount: 0n, claimedPositionCount: 0n, vault: Keypair.generate().publicKey.toBase58(), vaultBump: 1,
  };
}

function verifier(
  value: SettlementAttestationV1 | VoidAttestationV1 = attestation(),
  events: readonly MatchEvent[] = [EVENT],
  claimSpecificationJson = CLAIM_JSON,
) {
  const signer = environment();
  const signers = [signer.signer, Keypair.generate(), Keypair.generate()].map((item) => item.publicKey.toBase58());
  return new OracleAttestationVerifier({
    env: signer, clock: () => NOW_MS,
    chain: {
      async loadMarket() {
        return {
          slot: 100n, config: {} as ProtocolConfigAccount,
          oracleSet: { epoch: 9n, activationSlot: 1n, retirementSlot: null, version: 1, bump: 1, signers, signatureThreshold: 2 } as OracleSetAccount,
          market: market(value, claimSpecificationJson),
        };
      },
      async loadLot() { throw new Error('unused'); },
    },
    feed: { async scores() { return events; } },
  });
}

function invalidationVerifier(
  lotState: PositionLotAccount['state'],
  event = PRICE_MOVING_EVENT,
) {
  const value = invalidationAttestation(event);
  const signer = environment();
  const signers = [signer.signer, Keypair.generate(), Keypair.generate()].map((item) => item.publicKey.toBase58());
  const lot: PositionLotAccount = {
    version: 1,
    bump: 1,
    market: MARKET.toBase58(),
    owner: Keypair.generate().publicKey.toBase58(),
    nonce: value.lotNonce,
    side: 'back',
    amount: 10n,
    placedTimestamp: ACTIVATION_TIMESTAMP - 150n,
    placedSlot: 1n,
    observedEventEpoch: value.observedEventEpoch,
    state: lotState,
    activationTimestamp: ACTIVATION_TIMESTAMP,
    invalidationEvidenceHash: null,
  };
  return {
    value,
    verifier: new OracleAttestationVerifier({
      env: signer,
      clock: () => NOW_MS,
      chain: {
        async loadMarket() {
          return {
            slot: 100n,
            config: {} as ProtocolConfigAccount,
            oracleSet: {
              epoch: 9n,
              activationSlot: 1n,
              retirementSlot: null,
              version: 1,
              bump: 1,
              signers,
              signatureThreshold: 2,
            } as OracleSetAccount,
            market: { ...market(attestation()), eventEpoch: value.invalidatedEventEpoch },
          };
        },
        async loadLot() { return lot; },
      },
      feed: { async scores() { return [event]; } },
    }),
  };
}

function envelope(value = attestation(), claimSpecificationJson = CLAIM_JSON) {
  const canonical = encodeSettlementAttestationV1(value);
  return {
    schemaVersion: 1, kind: 'settlement', canonicalBytesBase64: Buffer.from(canonical).toString('base64'),
    canonicalSha256Hex: createHash('sha256').update(canonical).digest('hex'),
    clusterGenesisHashHex: bytesToHex(value.clusterGenesisHash), programIdHex: bytesToHex(value.escrowProgramId),
    marketPdaHex: bytesToHex(value.marketPda), marketDocumentHashHex: bytesToHex(value.marketDocumentHash),
    oracleSetEpoch: String(value.oracleSetEpoch), evidenceHashHex: bytesToHex(value.evidenceHash),
    claimSpecificationJson, evidenceCodecVersion: 2,
    attestationJson: JSON.parse(JSON.stringify(value, (_key, item) =>
      typeof item === 'bigint' ? item.toString() : item instanceof Uint8Array ? bytesToHex(item) : item)),
  };
}

function voidEnvelope(value = voidAttestation()) {
  const canonical = encodeVoidAttestationV1(value);
  return {
    schemaVersion: 1, kind: 'void', canonicalBytesBase64: Buffer.from(canonical).toString('base64'),
    canonicalSha256Hex: createHash('sha256').update(canonical).digest('hex'),
    clusterGenesisHashHex: bytesToHex(value.clusterGenesisHash), programIdHex: bytesToHex(value.escrowProgramId),
    marketPdaHex: bytesToHex(value.marketPda), marketDocumentHashHex: bytesToHex(value.marketDocumentHash),
    oracleSetEpoch: String(value.oracleSetEpoch), evidenceHashHex: bytesToHex(value.evidenceHash),
    claimSpecificationJson: CLAIM_JSON, evidenceCodecVersion: 2,
    attestationJson: JSON.parse(JSON.stringify(value, (_key, item) =>
      typeof item === 'bigint' ? item.toString() : item instanceof Uint8Array ? bytesToHex(item) : item)),
  };
}

const servers: Array<ReturnType<typeof createOracleSignerServer>> = [];
const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('independent oracle signer', () => {
  it('loads exact-network configuration while ignoring unrelated process environment keys', () => {
    const devnet = loadOracleSignerEnv(environmentSource({ UNRELATED_PLATFORM_VALUE: 'present' }));
    expect(devnet.ORACLE_SIGNER_NETWORK).toBe('devnet');
    expect(devnet.ESCROW_GENESIS_HASH).toBe(GENESIS);
  });

  it('loads the exact mainnet genesis when mainnet signing is explicitly enabled', () => {
    const mainnet = loadOracleSignerEnv(environmentSource({
      ORACLE_SIGNER_NETWORK: 'mainnet-beta',
      ORACLE_SIGNER_ALLOW_MAINNET: 'true',
      ESCROW_GENESIS_HASH: MAINNET_GENESIS,
      ANOTHER_UNRELATED_VALUE: 'present',
    }));
    expect(mainnet.ORACLE_SIGNER_NETWORK).toBe('mainnet-beta');
    expect(mainnet.ESCROW_GENESIS_HASH).toBe(MAINNET_GENESIS);
  });

  it('rejects crossed devnet and mainnet genesis configuration', () => {
    expect(() => loadOracleSignerEnv(environmentSource({ ESCROW_GENESIS_HASH: MAINNET_GENESIS })))
      .toThrow('oracle signer network and genesis hash do not match');
    expect(() => loadOracleSignerEnv(environmentSource({
      ORACLE_SIGNER_NETWORK: 'mainnet-beta',
      ORACLE_SIGNER_ALLOW_MAINNET: 'true',
      ESCROW_GENESIS_HASH: GENESIS,
    }))).toThrow('oracle signer network and genesis hash do not match');
  });

  it('parses exact canonical bytes and independently verifies the settlement', async () => {
    const parsed = parseOracleSigningEnvelope(envelope());
    await expect(verifier().verify(parsed.request, CLAIM_JSON)).resolves.toBeUndefined();
  });

  it('accepts pre-activation event evidence while the lot is pending', async () => {
    const candidate = invalidationVerifier('pending');

    await expect(candidate.verifier.verify(
      { kind: 'position_invalidation', attestation: candidate.value },
      CLAIM_JSON,
    )).resolves.toBeUndefined();
  });

  it('accepts delayed pre-activation event evidence after the lot becomes active', async () => {
    const candidate = invalidationVerifier('active');

    await expect(candidate.verifier.verify(
      { kind: 'position_invalidation', attestation: candidate.value },
      CLAIM_JSON,
    )).resolves.toBeUndefined();
  });

  it('rejects event evidence exactly at the activation boundary', async () => {
    const boundaryEvent = { ...PRICE_MOVING_EVENT, tsMs: Number(ACTIVATION_TIMESTAMP * 1_000n) };
    const candidate = invalidationVerifier('pending', boundaryEvent);

    await expect(candidate.verifier.verify(
      { kind: 'position_invalidation', attestation: candidate.value },
      CLAIM_JSON,
    )).rejects.toThrow('position invalidation evidence mismatch');
  });

  it('rejects event evidence after the activation boundary', async () => {
    const postActivationEvent = { ...PRICE_MOVING_EVENT, tsMs: Number((ACTIVATION_TIMESTAMP + 1n) * 1_000n) };
    const candidate = invalidationVerifier('active', postActivationEvent);

    await expect(candidate.verifier.verify(
      { kind: 'position_invalidation', attestation: candidate.value },
      CLAIM_JSON,
    )).rejects.toThrow('position invalidation evidence mismatch');
  });

  it('rejects a substituted evidence hash for a pre-activation event', async () => {
    const candidate = invalidationVerifier('pending');
    const substituted = invalidationAttestation(PRICE_MOVING_EVENT, {
      evidenceHash: new Uint8Array(32).fill(0xff),
    });

    await expect(candidate.verifier.verify(
      { kind: 'position_invalidation', attestation: substituted },
      CLAIM_JSON,
    )).rejects.toThrow('position invalidation evidence mismatch');
  });

  it('rejects a substituted outcome even when the envelope is internally canonical', async () => {
    const substituted = attestation({ outcome: 'claim_lost' });
    const parsed = parseOracleSigningEnvelope(envelope(substituted));
    await expect(verifier(substituted).verify(parsed.request, CLAIM_JSON)).rejects.toThrow('settlement attestation mismatch');
  });

  it('rejects a threshold outcome while the latest fixture phase is non-terminal', async () => {
    const liveGoal: MatchEvent = {
      ...EVENT,
      kind: 'goal',
      phase: 'H2',
      minute: 60,
      score: {
        ...EVENT.score,
        p1Goals90: null,
        p2Goals90: null,
      },
      detail: { participant: 1 },
    };
    const commitment = escrowEvidenceSequenceCommitmentV2(77, [liveGoal.seq]);
    const root = normalizedEscrowEvidenceHashV2(liveGoal);
    const liveSettlement = attestation({
      evidenceHash: settlementEvidenceHashV2(commitment, root),
      terminalPhase: liveGoal.phase,
      regulationScore: null,
      fullMatchScore: { home: 2, away: 1 },
      evidenceSequenceCommitment: commitment,
      normalizedEvidenceRoot: root,
    });
    const parsed = parseOracleSigningEnvelope(envelope(liveSettlement, THRESHOLD_CLAIM_JSON));

    await expect(verifier(liveSettlement, [liveGoal], THRESHOLD_CLAIM_JSON)
      .verify(parsed.request, THRESHOLD_CLAIM_JSON))
      .rejects.toThrow('settlement fixture phase is not terminal');
  });

  it('maps a postponed match void to undecidable', async () => {
    const valid = voidAttestation();
    const parsed = parseOracleSigningEnvelope(voidEnvelope(valid));
    await expect(verifier(valid, [POST_EVENT]).verify(parsed.request, CLAIM_JSON)).resolves.toBeUndefined();

    const wrongReason = voidAttestation(POST_EVENT, { reason: 'cancelled' });
    const wrong = parseOracleSigningEnvelope(voidEnvelope(wrongReason));
    await expect(verifier(wrongReason, [POST_EVENT]).verify(wrong.request, CLAIM_JSON))
      .rejects.toThrow('void reason mismatch');
  });

  it.each([
    { name: 'cancellation', event: { ...EVENT, phase: 'CAN' as const }, reason: 'cancelled' as const },
    {
      name: 'coverage warning',
      event: { ...EVENT, kind: 'coverage_warning' as const, phase: 'COV_LOST' as const },
      reason: 'coverage_loss' as const,
    },
  ])('rejects stale historical $name evidence for a current void', async ({ event, reason }) => {
    const current: MatchEvent = { ...EVENT, seq: event.seq + 1, tsMs: event.tsMs + 1_000 };
    const staleVoid = voidAttestation(event, { reason });
    const parsed = parseOracleSigningEnvelope(voidEnvelope(staleVoid));

    await expect(verifier(staleVoid, [event, current]).verify(parsed.request, CLAIM_JSON))
      .rejects.toThrow('void was reversed by later evidence');
  });

  it('rejects an envelope whose flat bindings do not match its canonical attestation', () => {
    expect(() => parseOracleSigningEnvelope({ ...envelope(), evidenceHashHex: '00'.repeat(32) }))
      .toThrow('oracle signing envelope binding mismatch');
  });

  it('uses provider-reproducible evidence that ignores local receipt time and player-name enrichment', () => {
    const changed = { ...EVENT, receivedAtMs: EVENT.receivedAtMs + 99_000, detail: { playerName: 'Local label' } };
    expect(bytesToHex(normalizedEscrowEvidenceHashV2(changed))).toBe(bytesToHex(normalizedEscrowEvidenceHashV2(EVENT)));
  });

  it('durably refuses a conflicting terminal signature after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'calledit-oracle-journal-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'journal.jsonl');
    const first = await OracleSignatureJournal.open(path);
    await first.record('terminal:market:9', 'aa'.repeat(32), new Date(NOW_MS));
    const restarted = await OracleSignatureJournal.open(path);
    await expect(restarted.record('terminal:market:9', 'bb'.repeat(32), new Date(NOW_MS)))
      .rejects.toThrow('equivocation');
  });

  it('serializes concurrent conflicting records and preserves the winner after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'calledit-oracle-journal-race-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'journal.jsonl');
    const journal = await OracleSignatureJournal.open(path);
    const hashes = ['aa'.repeat(32), 'bb'.repeat(32)] as const;
    const results = await Promise.allSettled(hashes.map((hash) =>
      journal.record('terminal:market:9', hash, new Date(NOW_MS))));

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const winnerIndex = results.findIndex((result) => result.status === 'fulfilled');
    const winner = hashes[winnerIndex]!;
    const loser = hashes[winnerIndex === 0 ? 1 : 0];

    const restarted = await OracleSignatureJournal.open(path);
    await expect(restarted.record('terminal:market:9', winner, new Date(NOW_MS))).resolves.toBeUndefined();
    await expect(restarted.record('terminal:market:9', loser, new Date(NOW_MS)))
      .rejects.toThrow('equivocation');
  });

  it('requires bearer auth and returns a verified detached signature', async () => {
    const signer = Keypair.generate();
    const verify = vi.fn(async (
      _request: Parameters<OracleAttestationVerifier['verify']>[0],
      _claimSpecificationJson: string,
    ) => undefined);
    const record = vi.fn(async (_key: string, _hash: string, _now?: Date) => undefined);
    const server = createOracleSignerServer({
      bearerToken: 't'.repeat(32), signer, journal: { record },
      verifier: { verify }, now: () => new Date(NOW_MS),
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing test server port');
    const endpoint = `http://127.0.0.1:${address.port}/sign`;
    expect((await fetch(endpoint)).status).toBe(401);
    expect(verify).not.toHaveBeenCalled();
    const requestEnvelope = envelope();
    const response = await fetch(endpoint, {
      method: 'POST', headers: { authorization: `Bearer ${'t'.repeat(32)}`, 'content-type': 'application/json' },
      body: JSON.stringify(requestEnvelope),
    });
    expect(response.status).toBe(200);
    const result = await response.json() as { signerPubkey: string; signatureBase64: string };
    expect(result.signerPubkey).toBe(signer.publicKey.toBase58());
    expect(verify).toHaveBeenCalledOnce();
    expect(verify.mock.calls[0]?.[1]).toBe(CLAIM_JSON);
    expect(record).toHaveBeenCalledWith(
      expect.stringMatching(/^terminal:/),
      requestEnvelope.canonicalSha256Hex,
      new Date(NOW_MS),
    );
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, signer.publicKey.toBuffer()]),
      format: 'der',
      type: 'spki',
    });
    expect(verifySignature(
      null,
      Buffer.from(requestEnvelope.canonicalBytesBase64, 'base64'),
      publicKey,
      Buffer.from(result.signatureBase64, 'base64'),
    )).toBe(true);
  });
});
