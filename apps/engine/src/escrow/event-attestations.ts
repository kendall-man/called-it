import { createHash } from 'node:crypto';
import type { MatchEvent, SettlementOutcome } from '@calledit/market-engine';
import {
  hexToBytes,
  type AttestationCommonV1,
  type FeedEventAttestationV1,
  type PositionInvalidationAttestationV1,
  type SettlementAttestationV1,
  type VoidAttestationV1,
  type VoidReason,
} from '@calledit/escrow-sdk';
import { base58Decode } from '@calledit/solana';

export interface EscrowAttestationMarketBinding {
  readonly marketId: string;
  readonly marketPda: string;
  readonly marketDocumentHashHex: string;
  readonly fixtureId: bigint;
  readonly oracleSetEpoch: bigint;
  readonly eventEpoch: bigint;
}

export interface EscrowAttestationDeploymentBinding {
  readonly genesisHash: string;
  readonly programId: string;
}

function sha256(domain: string, values: readonly (string | Uint8Array)[]): Uint8Array {
  const hash = createHash('sha256').update(domain).update('\0');
  for (const value of values) {
    const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
    const length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length);
    hash.update(length).update(bytes);
  }
  return Uint8Array.from(hash.digest());
}

function normalizedEvent(event: MatchEvent): string {
  const detail = event.detail;
  return JSON.stringify([
    event.kind,
    event.fixtureId,
    event.seq,
    event.tsMs,
    event.receivedAtMs,
    event.confirmed,
    event.phase,
    event.minute,
    event.score.p1.goals,
    event.score.p1.yellowCards,
    event.score.p1.redCards,
    event.score.p1.corners,
    event.score.p2.goals,
    event.score.p2.yellowCards,
    event.score.p2.redCards,
    event.score.p2.corners,
    event.score.p1Goals90,
    event.score.p2Goals90,
    detail?.participant ?? null,
    detail?.playerNormativeId ?? null,
    detail?.playerName ?? null,
    detail?.goalType ?? null,
    detail?.card ?? null,
    detail?.reversesSeq ?? null,
  ]);
}

export function normalizedEscrowEvidenceHash(event: MatchEvent): Uint8Array {
  return sha256('calledit.escrow.normalized-feed-event.v1', [normalizedEvent(event)]);
}

export function escrowEvidenceSequenceCommitment(
  fixtureId: number,
  evidenceSequences: readonly number[],
): Uint8Array {
  return sha256('calledit.escrow.evidence-sequences.v1', [
    String(fixtureId),
    JSON.stringify(evidenceSequences),
  ]);
}

function common(input: {
  readonly deployment: EscrowAttestationDeploymentBinding;
  readonly market: EscrowAttestationMarketBinding;
  readonly event: MatchEvent;
  readonly issuedAt: bigint;
  readonly ttlSeconds: bigint;
  readonly evidenceHash: Uint8Array;
}): AttestationCommonV1 {
  const genesis = base58Decode(input.deployment.genesisHash);
  const program = base58Decode(input.deployment.programId);
  const marketPda = base58Decode(input.market.marketPda);
  if (
    genesis.length !== 32 || program.length !== 32 || marketPda.length !== 32 ||
    input.market.fixtureId !== BigInt(input.event.fixtureId) || input.ttlSeconds <= 0n
  ) throw new TypeError('escrow attestation binding mismatch');
  return {
    clusterGenesisHash: genesis,
    escrowProgramId: program,
    marketPda,
    marketDocumentHash: hexToBytes(input.market.marketDocumentHashHex),
    fixtureId: input.market.fixtureId,
    oracleSetEpoch: input.market.oracleSetEpoch,
    issuedAt: input.issuedAt,
    expiresAt: input.issuedAt + input.ttlSeconds,
    evidenceHash: input.evidenceHash,
  };
}

type CommonInput = Omit<Parameters<typeof common>[0], 'evidenceHash'>;

export function buildEscrowFeedEventAttestation(
  input: CommonInput & { readonly eventKind: FeedEventAttestationV1['eventKind'] },
): FeedEventAttestationV1 {
  const evidenceHash = normalizedEscrowEvidenceHash(input.event);
  return {
    ...common({ ...input, evidenceHash }),
    eventKind: input.eventKind,
    eventEpoch: input.market.eventEpoch + 1n,
    decidingSequence: BigInt(input.event.seq),
    observedAt: BigInt(Math.floor(input.event.tsMs / 1_000)),
  };
}

export function buildEscrowPositionInvalidationAttestation(input: CommonInput & {
  readonly ownerPubkey: string;
  readonly lotNonce: bigint;
  readonly observedEventEpoch: bigint;
  readonly positionLotPda: string;
  readonly invalidatedEventEpoch?: bigint;
}): PositionInvalidationAttestationV1 {
  const evidenceHash = normalizedEscrowEvidenceHash(input.event);
  return {
    ...common({ ...input, evidenceHash }),
    positionLotPda: base58Decode(input.positionLotPda),
    lotNonce: input.lotNonce,
    observedEventEpoch: input.observedEventEpoch,
    invalidatedEventEpoch: input.invalidatedEventEpoch ?? input.market.eventEpoch + 1n,
    decidingSequence: BigInt(input.event.seq),
  };
}

export function buildEscrowSettlementAttestation(input: CommonInput & {
  readonly outcome: Exclude<SettlementOutcome, 'void'>;
  readonly decidingSequence: number;
  readonly evidenceSequences: readonly number[];
}): SettlementAttestationV1 {
  const evidenceSequenceCommitment = escrowEvidenceSequenceCommitment(
    input.event.fixtureId,
    input.evidenceSequences,
  );
  const normalizedEvidenceRoot = normalizedEscrowEvidenceHash(input.event);
  const evidenceHash = sha256('calledit.escrow.settlement-evidence.v1', [
    evidenceSequenceCommitment,
    normalizedEvidenceRoot,
  ]);
  const hasRegulationScore = input.event.score.p1Goals90 !== null && input.event.score.p2Goals90 !== null;
  return {
    ...common({ ...input, evidenceHash }),
    outcome: input.outcome,
    decidingSequence: BigInt(input.decidingSequence),
    terminalPhase: input.event.phase,
    regulationScore: hasRegulationScore
      ? { home: input.event.score.p1Goals90!, away: input.event.score.p2Goals90! }
      : input.event.phase === 'F'
        ? { home: input.event.score.p1.goals, away: input.event.score.p2.goals }
        : null,
    fullMatchScore: { home: input.event.score.p1.goals, away: input.event.score.p2.goals },
    evidenceSequenceCommitment,
    normalizedEvidenceRoot,
  };
}

export function buildEscrowVoidAttestation(input: CommonInput & {
  readonly reason: VoidReason;
  readonly decidingSequence: number;
}): VoidAttestationV1 {
  const evidenceHash = normalizedEscrowEvidenceHash(input.event);
  return {
    ...common({ ...input, evidenceHash }),
    reason: input.reason,
    decidingSequence: BigInt(input.decidingSequence),
  };
}
