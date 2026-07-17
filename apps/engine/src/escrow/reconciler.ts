import type { EscrowAsset, EscrowCluster, EscrowDb } from '@calledit/db';
import {
  settlePositions,
  type MarketState,
  type PositionSide,
  type SettlementOutcome,
} from '@calledit/escrow-sdk';

export interface EscrowReconciliationPosition {
  readonly ownerProgramId: string;
  readonly positionPda: string;
  readonly ownerPubkey: string;
  readonly side: PositionSide;
  readonly activeAmount: bigint;
  readonly pendingAmount: bigint;
  readonly refundableAmount: bigint;
  readonly nextLotNonce: bigint;
  readonly totalPaidAmount: bigint;
  readonly claimed: boolean;
}

export interface EscrowReconciliationSnapshot {
  readonly sourceSlot: bigint;
  readonly ownerProgramId: string;
  readonly marketId: string;
  readonly marketPda: string;
  readonly vaultPda: string;
  readonly asset: EscrowAsset;
  readonly tokenMint: string | null;
  readonly state: MarketState;
  readonly eventEpoch: bigint;
  readonly ratioMilli: bigint;
  readonly settlementOutcome: SettlementOutcome | null;
  readonly vaultPrincipalAtomic: bigint;
  readonly positions: readonly EscrowReconciliationPosition[];
}

export interface EscrowReconciliationChain {
  readFinalizedSnapshot(input: {
    readonly marketPda: string;
    readonly vaultPda: string;
    readonly asset: EscrowAsset;
  }): Promise<EscrowReconciliationSnapshot>;
}

export class EscrowReconciliationError extends Error {
  readonly name = 'EscrowReconciliationError';

  constructor(readonly code: 'custody_mismatch' | 'chain_identity_mismatch' | 'invalid_snapshot') {
    super(`escrow reconciliation rejected: ${code}`);
  }
}

type ReconciliationDb = Pick<EscrowDb, 'upsertPositionAccount' | 'recordReconciliation'>;

function checkedAmount(value: bigint): bigint {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new EscrowReconciliationError('invalid_snapshot');
  }
  return value;
}

function entitlementByPosition(snapshot: EscrowReconciliationSnapshot): ReadonlyMap<string, bigint> {
  const result = new Map<string, bigint>();
  if (snapshot.state === 'closed') return result;
  if (snapshot.state === 'settled' || snapshot.state === 'voided') {
    const outcome = snapshot.state === 'voided' ? 'void' : snapshot.settlementOutcome;
    if (outcome === null) throw new EscrowReconciliationError('invalid_snapshot');
    const settlement = settlePositions(snapshot.positions.map((position) => ({
      id: position.positionPda,
      owner: position.ownerPubkey,
      side: position.side,
      activeAmount: checkedAmount(position.activeAmount),
      pendingAmount: checkedAmount(position.pendingAmount),
      refundableAmount: checkedAmount(position.refundableAmount),
    })), outcome, snapshot.ratioMilli);
    for (const refund of settlement.refunds) {
      result.set(refund.positionId, (result.get(refund.positionId) ?? 0n) + refund.amount);
    }
    for (const position of snapshot.positions) {
      result.set(
        position.positionPda,
        (result.get(position.positionPda) ?? 0n) + (settlement.payouts.get(position.ownerPubkey) ?? 0n),
      );
    }
    return result;
  }
  for (const position of snapshot.positions) {
    result.set(
      position.positionPda,
      checkedAmount(position.activeAmount) + checkedAmount(position.pendingAmount) +
        checkedAmount(position.refundableAmount),
    );
  }
  return result;
}

function validateSnapshot(
  snapshot: EscrowReconciliationSnapshot,
  input: { readonly marketId: string; readonly marketPda: string; readonly vaultPda: string; readonly asset: EscrowAsset },
  expected: { readonly programId: string; readonly canonicalUsdcMint: string },
): void {
  if (
    snapshot.ownerProgramId !== expected.programId || snapshot.marketId !== input.marketId ||
    snapshot.marketPda !== input.marketPda || snapshot.vaultPda !== input.vaultPda || snapshot.asset !== input.asset ||
    snapshot.positions.some((position) => position.ownerProgramId !== expected.programId)
  ) throw new EscrowReconciliationError('chain_identity_mismatch');
  const expectedMint = input.asset === 'usdc' ? expected.canonicalUsdcMint : null;
  if (snapshot.tokenMint !== expectedMint) throw new EscrowReconciliationError('chain_identity_mismatch');
  if (snapshot.sourceSlot < 0n || snapshot.vaultPrincipalAtomic < 0n) {
    throw new EscrowReconciliationError('invalid_snapshot');
  }
}

export function createEscrowReconciler(options: {
  readonly db: ReconciliationDb;
  readonly chain: EscrowReconciliationChain;
  readonly expected: {
    readonly cluster: EscrowCluster;
    readonly programId: string;
    readonly canonicalUsdcMint: string;
    readonly custodyVersion: number;
  };
  readonly clock: () => string;
}) {
  return {
    async reconcile(input: {
      readonly marketId: string;
      readonly custodyMode: 'legacy' | 'escrow';
      readonly marketPda: string;
      readonly vaultPda: string;
      readonly asset: EscrowAsset;
    }) {
      if (input.custodyMode !== 'escrow' || options.expected.custodyVersion < 1) {
        throw new EscrowReconciliationError('custody_mismatch');
      }
      const snapshot = await options.chain.readFinalizedSnapshot(input);
      validateSnapshot(snapshot, input, options.expected);
      let entitlements: ReadonlyMap<string, bigint>;
      try {
        entitlements = entitlementByPosition(snapshot);
      } catch (error) {
        if (error instanceof EscrowReconciliationError) throw error;
        throw new EscrowReconciliationError('invalid_snapshot');
      }
      let liabilityAtomic = 0n;
      for (const position of snapshot.positions) {
        const entitlement = entitlements.get(position.positionPda) ?? 0n;
        if (!position.claimed) liabilityAtomic += entitlement;
        await options.db.upsertPositionAccount({
          marketId: snapshot.marketId,
          programId: options.expected.programId,
          ownerPubkey: position.ownerPubkey,
          positionPda: position.positionPda,
          side: position.side,
          asset: snapshot.asset,
          depositedAtomic: checkedAmount(position.totalPaidAmount),
          pendingAtomic: checkedAmount(position.pendingAmount),
          activeAtomic: checkedAmount(position.activeAmount),
          refundableAtomic: checkedAmount(position.refundableAmount),
          claimedAtomic: position.claimed ? entitlement : 0n,
          nextLotNonce: checkedAmount(position.nextLotNonce),
          sourceSlot: snapshot.sourceSlot,
          commitment: 'finalized',
          observedAtIso: options.clock(),
        });
      }
      const driftAtomic = snapshot.vaultPrincipalAtomic - liabilityAtomic;
      const status = driftAtomic === 0n ? 'in_sync' as const : 'drift' as const;
      await options.db.recordReconciliation({
        marketId: snapshot.marketId,
        cluster: options.expected.cluster,
        programId: options.expected.programId,
        checkedSlot: snapshot.sourceSlot,
        vaultBalanceAtomic: snapshot.vaultPrincipalAtomic,
        liabilityAtomic,
        positionAccountCount: snapshot.positions.length,
        status,
        details: {
          driftAtomic: driftAtomic.toString(), custodyMode: 'escrow', asset: snapshot.asset,
          chainState: snapshot.state, eventEpoch: snapshot.eventEpoch.toString(),
        },
        checkedAtIso: options.clock(),
      });
      return { status, liabilityAtomic, vaultPrincipalAtomic: snapshot.vaultPrincipalAtomic, driftAtomic };
    },
  };
}
