import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  encodeFeedEventAttestationV1,
  encodePositionInvalidationAttestationV1,
  encodeQuoteAttestationV1,
  encodeSettlementAttestationV1,
  encodeVoidAttestationV1,
  hashAttestationV1,
} from '../src/attestations.js';
import { bytesToHex, hexToBytes } from '../src/codec.js';
import { encodeMarketDocumentV1, hashMarketDocumentV1 } from '../src/domain.js';

const h = (byte: number) => new Uint8Array(32).fill(byte);
const golden = JSON.parse(readFileSync(
  new URL('../vectors/canonical-v1.json', import.meta.url),
  'utf8',
)) as { vectors: Record<string, { encoded_hex: string; hash_hex: string }> };
const common = {
  clusterGenesisHash: h(1),
  escrowProgramId: h(2),
  marketPda: h(3),
  marketDocumentHash: h(4),
  fixtureId: 91_001n,
  oracleSetEpoch: 7n,
  issuedAt: 1_730_000_000n,
  expiresAt: 1_730_000_300n,
  evidenceHash: h(5),
} as const;

describe('MarketDocumentV1 canonical encoding', () => {
  const document = {
    marketUuid: '00112233-4455-6677-8899-aabbccddeeff',
    fixtureId: 91_001n,
    claimSpec: '{"entity":"France","type":"match_winner"}',
    displayTerms: 'France will beat Morocco',
    asset: 'usdc' as const,
    probabilityPpm: 620_000,
    ratioMilli: 613,
    oddsMessageHash: h(9),
    oddsTimestamp: 1_730_000_000n,
    positionCutoff: 1_730_003_600n,
    resolutionDeadline: 1_730_090_000n,
    feeBps: 0,
    oracleSetEpoch: 7n,
    replayFlag: false,
  };

  it('is deterministic, domain separated, and hash sensitive', () => {
    const encoded = encodeMarketDocumentV1(document);
    expect(bytesToHex(encoded).startsWith('1900')).toBe(true);
    expect(hashMarketDocumentV1(document)).toEqual(hashMarketDocumentV1(document));
    expect(hashMarketDocumentV1({ ...document, replayFlag: true }))
      .not.toEqual(hashMarketDocumentV1(document));
  });

  it('rejects an inconsistent quote ratio and nonzero V1 fee', () => {
    expect(() => encodeMarketDocumentV1({ ...document, ratioMilli: 612 }))
      .toThrow(/ratio/);
    expect(() => encodeMarketDocumentV1({ ...document, feeBps: 1 }))
      .toThrow(/fee/);
  });
});

describe('V1 attestation canonical encodings', () => {
  const vectors = [
    encodeQuoteAttestationV1({
      ...common,
      probabilityPpm: 620_000,
      ratioMilli: 613,
      oddsTimestamp: 1_730_000_000n,
    }),
    encodeFeedEventAttestationV1({
      ...common,
      eventKind: 'price_moving',
      eventEpoch: 9n,
      decidingSequence: 1_234n,
      observedAt: 1_730_000_120n,
    }),
    encodePositionInvalidationAttestationV1({
      ...common,
      positionLotPda: h(6),
      lotNonce: 4n,
      observedEventEpoch: 8n,
      invalidatedEventEpoch: 9n,
      decidingSequence: 1_234n,
    }),
    encodeSettlementAttestationV1({
      ...common,
      outcome: 'claim_won',
      decidingSequence: 2_000n,
      terminalPhase: 'FT',
      regulationScore: { home: 2, away: 1 },
      fullMatchScore: { home: 2, away: 1 },
      evidenceSequenceCommitment: h(7),
      normalizedEvidenceRoot: h(8),
    }),
    encodeVoidAttestationV1({
      ...common,
      reason: 'coverage_loss',
      decidingSequence: 2_001n,
    }),
  ];

  it('uses a distinct domain and stable hash for every attestation kind', () => {
    expect(new Set(vectors.map(bytesToHex)).size).toBe(5);
    expect(new Set(vectors.map((bytes) => bytesToHex(hashAttestationV1(bytes)))).size).toBe(5);
  });

  it('matches the cross-language fixed golden vectors byte for byte', () => {
    const names = ['quote', 'feed_event', 'position_invalidation', 'settlement', 'void'];
    for (const [index, name] of names.entries()) {
      const expected = golden.vectors[name];
      const encoded = vectors[index];
      expect(expected).toBeDefined();
      expect(encoded).toBeDefined();
      expect(bytesToHex(encoded!)).toBe(expected!.encoded_hex);
      expect(bytesToHex(hashAttestationV1(encoded!))).toBe(expected!.hash_hex);
    }
  });

  it('validates hash widths and validity windows', () => {
    expect(() => encodeQuoteAttestationV1({
      ...common,
      evidenceHash: hexToBytes('aa'),
      probabilityPpm: 620_000,
      ratioMilli: 613,
      oddsTimestamp: 1n,
    })).toThrow(/32 bytes/);
    expect(() => encodeVoidAttestationV1({
      ...common,
      expiresAt: common.issuedAt,
      reason: 'undecidable',
      decidingSequence: 1n,
    })).toThrow(/expiry/);
  });
});

describe('cross-language market golden vector', () => {
  it('matches the fixed market document bytes and hash', () => {
    const document = {
      marketUuid: '00112233-4455-6677-8899-aabbccddeeff',
      fixtureId: 91_001n,
      claimSpec: '{"entity":"France","type":"match_winner"}',
      displayTerms: 'France will beat Morocco',
      asset: 'usdc' as const,
      probabilityPpm: 620_000,
      ratioMilli: 613,
      oddsMessageHash: h(9),
      oddsTimestamp: 1_730_000_000n,
      positionCutoff: 1_730_003_600n,
      resolutionDeadline: 1_730_090_000n,
      feeBps: 0,
      oracleSetEpoch: 7n,
      replayFlag: false,
    };
    expect(bytesToHex(encodeMarketDocumentV1(document)))
      .toBe(golden.vectors.market!.encoded_hex);
    expect(bytesToHex(hashMarketDocumentV1(document)))
      .toBe(golden.vectors.market!.hash_hex);
  });
});
