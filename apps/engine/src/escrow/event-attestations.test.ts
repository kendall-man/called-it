import type { MatchEvent } from '@calledit/market-engine';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { bytesToHex } from '@calledit/escrow-sdk';
import {
  buildEscrowFeedEventAttestation,
  buildEscrowSettlementAttestation,
  normalizedEscrowEvidenceHash,
} from './event-attestations.js';

const event: MatchEvent = {
  kind: 'phase_change', fixtureId: 77, seq: 12, tsMs: 1_700_000_000_000,
  receivedAtMs: 1_700_000_001_000, confirmed: true, phase: 'F', minute: 90,
  score: {
    p1: { goals: 2, yellowCards: 1, redCards: 0, corners: 4 },
    p2: { goals: 1, yellowCards: 2, redCards: 0, corners: 3 },
    p1Goals90: 2, p2Goals90: 1,
  },
};
const deployment = {
  genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  programId: 'HrKUo8Bue31kU9sobzQGK5qDxVxBu5nBLXP3aGeKCDFL',
};
const market = {
  marketId: '123e4567-e89b-12d3-a456-426614174000',
  marketPda: Keypair.generate().publicKey.toBase58(),
  marketDocumentHashHex: 'ab'.repeat(32), fixtureId: 77n,
  oracleSetEpoch: 7n, eventEpoch: 3n,
};

describe('escrow event attestations', () => {
  it('builds deterministic evidence independent of object identity', () => {
    expect(bytesToHex(normalizedEscrowEvidenceHash(event))).toBe(
      bytesToHex(normalizedEscrowEvidenceHash({ ...event, score: { ...event.score } })),
    );
  });

  it('binds feed attestations to the next event epoch and exact deciding event', () => {
    const value = buildEscrowFeedEventAttestation({
      deployment, market, event, issuedAt: 100n, ttlSeconds: 120n, eventKind: 'freeze',
    });
    expect(value).toMatchObject({ fixtureId: 77n, oracleSetEpoch: 7n, eventEpoch: 4n, decidingSequence: 12n });
    expect(value.expiresAt).toBe(220n);
  });

  it('binds terminal scores, sequence commitment, and normalized evidence', () => {
    const value = buildEscrowSettlementAttestation({
      deployment, market, event, issuedAt: 100n, ttlSeconds: 120n,
      outcome: 'claim_won', decidingSequence: 12, evidenceSequences: [8, 12],
    });
    expect(value).toMatchObject({
      terminalPhase: 'F', regulationScore: { home: 2, away: 1 },
      fullMatchScore: { home: 2, away: 1 }, decidingSequence: 12n,
    });
    expect(bytesToHex(value.evidenceHash)).not.toBe(bytesToHex(value.normalizedEvidenceRoot));
  });
});
