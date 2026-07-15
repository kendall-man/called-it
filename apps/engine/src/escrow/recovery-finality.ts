import { bytesToHex, derivePositionLotPda, deriveUserPositionPda } from '@calledit/escrow-sdk';
import { parseRecoveryPayload, restoreSettlement, restoreVoid } from './recovery-payload.js';
import type { EscrowRecoveryChain } from './recovery-relayer.js';
import type {
  DurableEscrowRelayerJobRow,
  EscrowRelayerFinalityVerifier,
} from './relayer-worker.js';

function terminalMismatch(state: string): 'pending' | 'mismatch' {
  return state === 'closed' || state === 'voided' || state === 'settled' ? 'mismatch' : 'pending';
}

export function createEscrowRecoveryFinalityVerifier(options: {
  readonly chain: EscrowRecoveryChain;
  readonly programId: string;
}): EscrowRelayerFinalityVerifier {
  return {
    async confirm(job: DurableEscrowRelayerJobRow) {
      const payload = parseRecoveryPayload(job);
      const market = await options.chain.market(payload.marketPda);
      if (payload.operation === 'close_market') return market === null ? 'confirmed' : 'pending';
      if (market === null || market.ownerProgramId !== options.programId) return 'pending';
      if (payload.operation === 'settle_market') {
        const attestation = restoreSettlement(payload.attestation);
        if (
          (market.value.state === 'settling' || market.value.state === 'settled') &&
          market.value.settlementOutcome === attestation.outcome &&
          market.value.settlementEvidenceHash !== null &&
          bytesToHex(market.value.settlementEvidenceHash) === bytesToHex(attestation.evidenceHash)
        ) return 'confirmed';
        return terminalMismatch(market.value.state);
      }
      if (payload.operation === 'void_market' || payload.operation === 'timeout_void') {
        const expectedEvidence = payload.operation === 'void_market'
          ? bytesToHex(restoreVoid(payload.attestation).evidenceHash)
          : '00'.repeat(32);
        if (
          market.value.state === 'voided' && market.value.settlementEvidenceHash !== null &&
          bytesToHex(market.value.settlementEvidenceHash) === expectedEvidence
        ) return 'confirmed';
        return market.value.state === 'settled' || market.value.state === 'closed' ? 'mismatch' : 'pending';
      }
      if (payload.owner === undefined) return 'mismatch';
      const positionAddress = deriveUserPositionPda(options.programId, payload.marketPda, payload.owner).address;
      const position = await options.chain.position(positionAddress);
      if (payload.operation === 'close_position') return position === null ? 'confirmed' : 'pending';
      if (payload.operation === 'close_position_lots') {
        if (payload.lotNonces === undefined) return 'mismatch';
        const present = await Promise.all(payload.lotNonces.map((nonce) => options.chain.accountExists(
          derivePositionLotPda(options.programId, payload.marketPda, payload.owner ?? '', BigInt(nonce)).address,
        )));
        return present.every((value) => !value) ? 'confirmed' : 'pending';
      }
      if (payload.operation === 'claim_position_for') {
        if (position === null) return 'confirmed';
        return position.value.claimed ? 'confirmed' : 'pending';
      }
      if (payload.operation === 'calculate_position_entitlement') {
        if (position === null) return 'mismatch';
        return position.value.settlementProcessed || market.value.state === 'settled' ? 'confirmed' : 'pending';
      }
      return 'mismatch';
    },
  };
}
