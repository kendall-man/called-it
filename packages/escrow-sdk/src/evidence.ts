import { sha256 } from '@noble/hashes/sha256';

export interface EscrowNormalizedEventV1 {
  readonly kind: string;
  readonly fixtureId: number;
  readonly seq: number;
  readonly tsMs: number;
  readonly receivedAtMs: number;
  readonly confirmed: boolean;
  readonly phase: string;
  readonly minute: number | null;
  readonly score: {
    readonly p1: { readonly goals: number; readonly yellowCards: number; readonly redCards: number; readonly corners: number };
    readonly p2: { readonly goals: number; readonly yellowCards: number; readonly redCards: number; readonly corners: number };
    readonly p1Goals90: number | null;
    readonly p2Goals90: number | null;
  };
  readonly detail?: {
    readonly participant?: 1 | 2;
    readonly playerNormativeId?: number | null;
    readonly playerName?: string | null;
    readonly goalType?: string;
    readonly card?: string;
    readonly reversesSeq?: number;
  };
}

function digest(domain: string, values: readonly (string | Uint8Array)[]): Uint8Array {
  const hash = sha256.create().update(new TextEncoder().encode(`${domain}\0`));
  for (const value of values) {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, bytes.length, true);
    hash.update(length).update(bytes);
  }
  return Uint8Array.from(hash.digest());
}

function normalizedEvent(event: EscrowNormalizedEventV1): string {
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

export function normalizedEscrowEvidenceHashV1(event: EscrowNormalizedEventV1): Uint8Array {
  return digest('calledit.escrow.normalized-feed-event.v1', [normalizedEvent(event)]);
}

function providerEvidence(event: EscrowNormalizedEventV1): string {
  const detail = event.detail;
  return JSON.stringify([
    event.kind, event.fixtureId, event.seq, event.tsMs, event.confirmed, event.phase, event.minute,
    event.score.p1.goals, event.score.p1.yellowCards, event.score.p1.redCards, event.score.p1.corners,
    event.score.p2.goals, event.score.p2.yellowCards, event.score.p2.redCards, event.score.p2.corners,
    event.score.p1Goals90, event.score.p2Goals90,
    detail?.participant ?? null, detail?.playerNormativeId ?? null,
    detail?.goalType ?? null, detail?.card ?? null, detail?.reversesSeq ?? null,
  ]);
}

export function normalizedEscrowEvidenceHashV2(event: EscrowNormalizedEventV1): Uint8Array {
  return digest('calledit.escrow.normalized-feed-event.v2', [providerEvidence(event)]);
}

export function escrowEvidenceSequenceCommitmentV1(
  fixtureId: number,
  evidenceSequences: readonly number[],
): Uint8Array {
  return digest('calledit.escrow.evidence-sequences.v1', [
    String(fixtureId),
    JSON.stringify(evidenceSequences),
  ]);
}

export function escrowEvidenceSequenceCommitmentV2(
  fixtureId: number,
  evidenceSequences: readonly number[],
): Uint8Array {
  return digest('calledit.escrow.evidence-sequences.v2', [
    String(fixtureId),
    JSON.stringify(evidenceSequences),
  ]);
}

export function settlementEvidenceHashV1(
  evidenceSequenceCommitment: Uint8Array,
  normalizedEvidenceRoot: Uint8Array,
): Uint8Array {
  return digest('calledit.escrow.settlement-evidence.v1', [
    evidenceSequenceCommitment,
    normalizedEvidenceRoot,
  ]);
}

export function settlementEvidenceHashV2(
  evidenceSequenceCommitment: Uint8Array,
  normalizedEvidenceRoot: Uint8Array,
): Uint8Array {
  return digest('calledit.escrow.settlement-evidence.v2', [
    evidenceSequenceCommitment,
    normalizedEvidenceRoot,
  ]);
}
