import { derivePositionLotPda, deriveUserPositionPda, type PositionLotAccount, type UserPositionAccount } from '@calledit/escrow-sdk';
import type { DecodedEscrowAccount } from './solana-accounts.js';
import { placementRelayPayload } from './placement-relay.js';
import type { DurableEscrowRelayerJobRow, EscrowRelayerFinalityVerifier } from './relayer-worker.js';

export interface EscrowPlacementFinalityChain {
  position(address: string): Promise<DecodedEscrowAccount<UserPositionAccount> | null>;
  lot(address: string): Promise<DecodedEscrowAccount<PositionLotAccount> | null>;
}

export function createEscrowPlacementFinalityVerifier(options: {
  readonly chain: EscrowPlacementFinalityChain;
}): EscrowRelayerFinalityVerifier {
  return {
    async confirm(job) {
      const payload = placementRelayPayload(job);
      if (payload === null) return 'mismatch';
      const nonce = BigInt(payload.lotNonce);
      const positionPda = deriveUserPositionPda(payload.programId, payload.marketPda, payload.ownerPubkey).address;
      const lotPda = derivePositionLotPda(payload.programId, payload.marketPda, payload.ownerPubkey, nonce).address;
      const [position, lot] = await Promise.all([
        options.chain.position(positionPda),
        options.chain.lot(lotPda),
      ]);
      if (position === null || lot === null) return 'pending';
      if (
        position.ownerProgramId !== payload.programId || lot.ownerProgramId !== payload.programId ||
        position.address !== positionPda || lot.address !== lotPda ||
        position.value.market !== payload.marketPda || position.value.owner !== payload.ownerPubkey ||
        position.value.side !== payload.side || position.value.nextLotNonce <= nonce ||
        lot.value.market !== payload.marketPda || lot.value.owner !== payload.ownerPubkey ||
        lot.value.nonce !== nonce || lot.value.side !== payload.side ||
        lot.value.amount !== BigInt(payload.amountAtomic) ||
        lot.value.observedEventEpoch !== BigInt(payload.eventEpoch)
      ) return 'mismatch';
      return 'confirmed';
    },
  };
}
