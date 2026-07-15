import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  buildEscrowFeedEventAttestation,
  buildEscrowPositionInvalidationAttestation,
  buildEscrowSettlementAttestation,
  buildEscrowVoidAttestation,
} from './event-attestations.js';
import {
  attestationPayloadHash,
  attestationSigningRequest,
  createSignedAttestationPayload,
  createUnsignedAttestationPayload,
  parseSignedAttestationPayload,
  restoreSignedWorkflowRequest,
  type EscrowUnsignedWorkflowRequest,
} from './attestation-request-payload.js';

const MARKET_ID = '123e4567-e89b-12d3-a456-426614174000';
const PROGRAM = Keypair.generate().publicKey.toBase58();
const MARKET = Keypair.generate().publicKey.toBase58();
const LOT = Keypair.generate().publicKey.toBase58();
const OWNER = Keypair.generate().publicKey.toBase58();
const common = {
  deployment: { genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', programId: PROGRAM },
  market: {
    marketId: MARKET_ID, marketPda: MARKET, marketDocumentHashHex: 'ab'.repeat(32),
    fixtureId: 77n, oracleSetEpoch: 9n, eventEpoch: 4n,
  },
  event: {
    kind: 'phase_change' as const, fixtureId: 77, seq: 20, tsMs: 100_000, receivedAtMs: 101_000,
    confirmed: true, phase: 'F' as const, minute: 90,
    score: {
      p1: { goals: 2, yellowCards: 0, redCards: 0, corners: 0 },
      p2: { goals: 1, yellowCards: 0, redCards: 0, corners: 0 },
      p1Goals90: 2, p2Goals90: 1,
    },
  },
  issuedAt: 1_700_000_000n, ttlSeconds: 300n,
};
const policy = {
  oracleSetEpoch: 9n,
  signers: [Keypair.generate(), Keypair.generate(), Keypair.generate()].map((value) => value.publicKey.toBase58()),
  threshold: 2,
} as const;

function requests(): readonly EscrowUnsignedWorkflowRequest[] {
  return [
    {
      operation: 'freeze_market', marketPda: MARKET, expectedEventEpoch: 4n,
      attestation: buildEscrowFeedEventAttestation({ ...common, eventKind: 'freeze' }),
    },
    {
      operation: 'unfreeze_market', marketPda: MARKET,
      attestation: buildEscrowFeedEventAttestation({ ...common, eventKind: 'unfreeze' }),
    },
    {
      operation: 'invalidate_position_lot', marketPda: MARKET, owner: OWNER, lotNonce: 3n, positionLotPda: LOT,
      attestation: buildEscrowPositionInvalidationAttestation({
        ...common, ownerPubkey: OWNER, lotNonce: 3n, observedEventEpoch: 4n, positionLotPda: LOT,
      }),
    },
    {
      operation: 'settle_market', marketPda: MARKET,
      attestation: buildEscrowSettlementAttestation({
        ...common, outcome: 'claim_won', decidingSequence: 20, evidenceSequences: [20],
      }),
    },
    {
      operation: 'void_market', marketPda: MARKET,
      attestation: buildEscrowVoidAttestation({ ...common, reason: 'cancelled', decidingSequence: 20 }),
    },
  ];
}

describe('durable attestation request payload', () => {
  it.each(requests())('round-trips $operation across a signed restart', (request) => {
    const unsigned = createUnsignedAttestationPayload({
      marketId: MARKET_ID, documentHashHex: 'ab'.repeat(32), eventEpoch: 4n,
      replay: false, oraclePolicy: policy, request,
    });
    const unsignedHash = attestationPayloadHash(unsigned);
    const signed = createSignedAttestationPayload(unsignedHash, policy.signers.slice(0, 2).map(() => ({
      publicKey: new Uint8Array(32), signature: new Uint8Array(64),
    })));

    expect(attestationSigningRequest(unsigned).kind).toBe(unsigned.signingKind);
    expect(restoreSignedWorkflowRequest(unsigned, signed).operation).toBe(request.operation);
    expect(attestationPayloadHash(signed)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a signed payload attached to different canonical bytes', () => {
    const request = requests()[0];
    if (request === undefined) throw new TypeError('missing attestation fixture');
    const unsigned = createUnsignedAttestationPayload({
      marketId: MARKET_ID, documentHashHex: 'ab'.repeat(32), eventEpoch: 4n,
      replay: false, oraclePolicy: policy, request,
    });
    const signed = createSignedAttestationPayload(attestationPayloadHash(unsigned), [{
      publicKey: new Uint8Array(32), signature: new Uint8Array(64),
    }, {
      publicKey: new Uint8Array(32), signature: new Uint8Array(64),
    }]);

    expect(() => parseSignedAttestationPayload(signed, '00'.repeat(32))).toThrow('mismatch');
  });
});
