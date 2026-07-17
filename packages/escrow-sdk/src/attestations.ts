import {
  CanonicalWriter,
  assertInteger,
  hashCanonicalBytes,
  writeDomain,
} from './codec.js';
import { ratioMilliFromProbabilityPpm } from './math-reference.js';
import type { SettlementOutcome } from './domain.js';

export const ATTESTATION_DOMAINS_V1 = {
  quote: 'calledit.escrow.attestation.quote.v1',
  feedEvent: 'calledit.escrow.attestation.feed-event.v1',
  positionInvalidation: 'calledit.escrow.attestation.position-invalidation.v1',
  settlement: 'calledit.escrow.attestation.settlement.v1',
  void: 'calledit.escrow.attestation.void.v1',
} as const;

export interface AttestationCommonV1 {
  readonly clusterGenesisHash: Uint8Array;
  readonly escrowProgramId: Uint8Array;
  readonly marketPda: Uint8Array;
  readonly marketDocumentHash: Uint8Array;
  readonly fixtureId: bigint;
  readonly oracleSetEpoch: bigint;
  readonly issuedAt: bigint;
  readonly expiresAt: bigint;
  readonly evidenceHash: Uint8Array;
}

export interface QuoteAttestationV1 extends AttestationCommonV1 {
  readonly probabilityPpm: number;
  readonly ratioMilli: number;
  readonly oddsTimestamp: bigint;
}

export type FeedEventKind = 'freeze' | 'unfreeze' | 'price_moving';
export interface FeedEventAttestationV1 extends AttestationCommonV1 {
  readonly eventKind: FeedEventKind;
  readonly eventEpoch: bigint;
  readonly decidingSequence: bigint;
  readonly observedAt: bigint;
}

export interface PositionInvalidationAttestationV1 extends AttestationCommonV1 {
  readonly positionLotPda: Uint8Array;
  readonly lotNonce: bigint;
  readonly observedEventEpoch: bigint;
  readonly invalidatedEventEpoch: bigint;
  readonly decidingSequence: bigint;
}

export interface ScoreV1 {
  readonly home: number;
  readonly away: number;
}

export interface SettlementAttestationV1 extends AttestationCommonV1 {
  readonly outcome: Exclude<SettlementOutcome, 'void'>;
  readonly decidingSequence: bigint;
  readonly terminalPhase: string;
  readonly regulationScore: ScoreV1 | null;
  readonly fullMatchScore: ScoreV1 | null;
  readonly evidenceSequenceCommitment: Uint8Array;
  readonly normalizedEvidenceRoot: Uint8Array;
}

export type VoidReason = 'cancelled' | 'abandoned' | 'coverage_loss' | 'undecidable';
export interface VoidAttestationV1 extends AttestationCommonV1 {
  readonly reason: VoidReason;
  readonly decidingSequence: bigint;
}

const EVENT_KIND_TAG: Readonly<Record<FeedEventKind, number>> = {
  freeze: 0,
  unfreeze: 1,
  price_moving: 2,
};
const OUTCOME_TAG = { claim_won: 0, claim_lost: 1 } as const;
const VOID_REASON_TAG: Readonly<Record<VoidReason, number>> = {
  cancelled: 0,
  abandoned: 1,
  coverage_loss: 2,
  undecidable: 3,
};

function writerFor(domain: string, common: AttestationCommonV1): CanonicalWriter {
  if (common.expiresAt <= common.issuedAt) {
    throw new Error('attestation expiry must be later than its issue timestamp');
  }
  const writer = new CanonicalWriter();
  writeDomain(writer, domain);
  return writer
    .fixed(common.clusterGenesisHash, 32, 'cluster genesis hash')
    .fixed(common.escrowProgramId, 32, 'escrow program ID')
    .fixed(common.marketPda, 32, 'market PDA')
    .fixed(common.marketDocumentHash, 32, 'market document hash')
    .u64(common.fixtureId, 'fixture ID')
    .u64(common.oracleSetEpoch, 'oracle-set epoch')
    .i64(common.issuedAt, 'issued timestamp')
    .i64(common.expiresAt, 'expiry timestamp')
    .fixed(common.evidenceHash, 32, 'evidence hash');
}

function writeOptionalScore(writer: CanonicalWriter, score: ScoreV1 | null, name: string): void {
  writer.bool(score !== null, `${name} present`);
  if (score !== null) {
    writer
      .u16(assertInteger(score.home, `${name} home`, 0, 0xffff), `${name} home`)
      .u16(assertInteger(score.away, `${name} away`, 0, 0xffff), `${name} away`);
  }
}

export function encodeQuoteAttestationV1(attestation: QuoteAttestationV1): Uint8Array {
  const expectedRatio = ratioMilliFromProbabilityPpm(attestation.probabilityPpm);
  if (attestation.ratioMilli !== expectedRatio) {
    throw new Error(`quote attestation ratio must equal ${expectedRatio}`);
  }
  return writerFor(ATTESTATION_DOMAINS_V1.quote, attestation)
    .u32(assertInteger(attestation.probabilityPpm, 'probability PPM', 1, 999_999), 'probability PPM')
    .u32(attestation.ratioMilli, 'ratio milli')
    .i64(attestation.oddsTimestamp, 'odds timestamp')
    .finish();
}

export function encodeFeedEventAttestationV1(attestation: FeedEventAttestationV1): Uint8Array {
  return writerFor(ATTESTATION_DOMAINS_V1.feedEvent, attestation)
    .u8(EVENT_KIND_TAG[attestation.eventKind], 'event kind')
    .u64(attestation.eventEpoch, 'event epoch')
    .u64(attestation.decidingSequence, 'deciding sequence')
    .i64(attestation.observedAt, 'observed timestamp')
    .finish();
}

export function encodePositionInvalidationAttestationV1(
  attestation: PositionInvalidationAttestationV1,
): Uint8Array {
  if (attestation.invalidatedEventEpoch <= attestation.observedEventEpoch) {
    throw new Error('invalidation event epoch must be later than the observed event epoch');
  }
  return writerFor(ATTESTATION_DOMAINS_V1.positionInvalidation, attestation)
    .fixed(attestation.positionLotPda, 32, 'position lot PDA')
    .u64(attestation.lotNonce, 'lot nonce')
    .u64(attestation.observedEventEpoch, 'observed event epoch')
    .u64(attestation.invalidatedEventEpoch, 'invalidated event epoch')
    .u64(attestation.decidingSequence, 'deciding sequence')
    .finish();
}

export function encodeSettlementAttestationV1(attestation: SettlementAttestationV1): Uint8Array {
  const writer = writerFor(ATTESTATION_DOMAINS_V1.settlement, attestation)
    .u8(OUTCOME_TAG[attestation.outcome], 'settlement outcome')
    .u64(attestation.decidingSequence, 'deciding sequence')
    .string16(attestation.terminalPhase, 'terminal phase', 32);
  if (attestation.terminalPhase.length === 0) throw new Error('terminal phase must not be empty');
  writeOptionalScore(writer, attestation.regulationScore, 'regulation score');
  writeOptionalScore(writer, attestation.fullMatchScore, 'full-match score');
  return writer
    .fixed(attestation.evidenceSequenceCommitment, 32, 'evidence sequence commitment')
    .fixed(attestation.normalizedEvidenceRoot, 32, 'normalized evidence root')
    .finish();
}

export function encodeVoidAttestationV1(attestation: VoidAttestationV1): Uint8Array {
  return writerFor(ATTESTATION_DOMAINS_V1.void, attestation)
    .u8(VOID_REASON_TAG[attestation.reason], 'void reason')
    .u64(attestation.decidingSequence, 'deciding sequence')
    .finish();
}

export function hashAttestationV1(canonicalBytes: Uint8Array): Uint8Array {
  return hashCanonicalBytes(canonicalBytes);
}

export function hashQuoteAttestationV1(attestation: QuoteAttestationV1): Uint8Array {
  return hashAttestationV1(encodeQuoteAttestationV1(attestation));
}

export function hashFeedEventAttestationV1(attestation: FeedEventAttestationV1): Uint8Array {
  return hashAttestationV1(encodeFeedEventAttestationV1(attestation));
}

export function hashPositionInvalidationAttestationV1(
  attestation: PositionInvalidationAttestationV1,
): Uint8Array {
  return hashAttestationV1(encodePositionInvalidationAttestationV1(attestation));
}

export function hashSettlementAttestationV1(attestation: SettlementAttestationV1): Uint8Array {
  return hashAttestationV1(encodeSettlementAttestationV1(attestation));
}

export function hashVoidAttestationV1(attestation: VoidAttestationV1): Uint8Array {
  return hashAttestationV1(encodeVoidAttestationV1(attestation));
}
