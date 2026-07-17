import type { EscrowDb } from '@calledit/db';
import { describe, expect, it } from 'vitest';
import {
  createEscrowReconciler,
  EscrowReconciliationError,
  type EscrowReconciliationSnapshot,
} from './reconciler.js';

const MARKET_ID = '123e4567-e89b-12d3-a456-426614174000';
const PROGRAM_ID = 'BPFLoaderUpgradeab1e11111111111111111111111';
const NOW = '2026-07-15T00:00:00.000Z';

function snapshot(asset: 'sol' | 'usdc'): EscrowReconciliationSnapshot {
  return {
    sourceSlot: 55n,
    ownerProgramId: PROGRAM_ID,
    marketId: MARKET_ID,
    marketPda: 'market-a',
    vaultPda: 'vault-a',
    asset,
    tokenMint: asset === 'usdc' ? 'mint-a' : null,
    state: 'open',
    eventEpoch: 0n,
    ratioMilli: 1_500n,
    settlementOutcome: null,
    vaultPrincipalAtomic: 25n,
    positions: [{
      ownerProgramId: PROGRAM_ID,
      positionPda: 'position-a',
      ownerPubkey: 'owner-a',
      side: 'back',
      activeAmount: 20n,
      pendingAmount: 3n,
      refundableAmount: 2n,
      nextLotNonce: 1n,
      totalPaidAmount: 25n,
      claimed: false,
    }],
  };
}

function setup(value: EscrowReconciliationSnapshot) {
  const positions: Parameters<EscrowDb['upsertPositionAccount']>[0][] = [];
  const checks: Parameters<EscrowDb['recordReconciliation']>[0][] = [];
  const db: Pick<EscrowDb, 'upsertPositionAccount' | 'recordReconciliation'> = {
    async upsertPositionAccount(input) {
      positions.push(input);
      return { ok: true, duplicate: false, finalized: true };
    },
    async recordReconciliation(input) {
      checks.push(input);
      return { ok: true, duplicate: false, finalized: true };
    },
  };
  const reconciler = createEscrowReconciler({
    db,
    chain: { readFinalizedSnapshot: async () => value },
    expected: {
      cluster: 'devnet', programId: PROGRAM_ID, canonicalUsdcMint: 'mint-a', custodyVersion: 1,
    },
    clock: () => NOW,
  });
  return { reconciler, positions, checks };
}

describe('finalized escrow account reconciliation', () => {
  it.each(['sol', 'usdc'] as const)('reconciles direct %s vault principal and position accounts', async (asset) => {
    // Given a finalized chain snapshot whose vault equals unclaimed liabilities
    const fixture = setup(snapshot(asset));

    // When reconciliation runs
    const result = await fixture.reconciler.reconcile({
      marketId: MARKET_ID, custodyMode: 'escrow', marketPda: 'market-a', vaultPda: 'vault-a', asset,
    });

    // Then finalized account values, not a legacy ledger, are mirrored into 0024
    expect(result).toEqual({ status: 'in_sync', liabilityAtomic: 25n, vaultPrincipalAtomic: 25n, driftAtomic: 0n });
    expect(fixture.positions[0]).toMatchObject({
      marketId: MARKET_ID, depositedAtomic: 25n, pendingAtomic: 3n,
      activeAtomic: 20n, refundableAtomic: 2n, claimedAtomic: 0n,
      commitment: 'finalized',
    });
    expect(fixture.checks[0]).toMatchObject({ status: 'in_sync', positionAccountCount: 1 });
  });

  it('records unexplained drift instead of treating it as spendable balance', async () => {
    // Given a finalized vault below its direct account liabilities
    const value = { ...snapshot('sol'), vaultPrincipalAtomic: 24n };
    const fixture = setup(value);

    // When reconciliation runs
    const result = await fixture.reconciler.reconcile({
      marketId: MARKET_ID, custodyMode: 'escrow', marketPda: 'market-a', vaultPda: 'vault-a', asset: 'sol',
    });

    // Then the market is marked drifted with a signed delta
    expect(result).toEqual({ status: 'drift', liabilityAtomic: 25n, vaultPrincipalAtomic: 24n, driftAtomic: -1n });
    expect(fixture.checks[0]?.details).toEqual({
      driftAtomic: '-1', custodyMode: 'escrow', asset: 'sol', chainState: 'open', eventEpoch: '0',
    });
  });

  it('projects finalized freeze state and event epoch through reconciliation', async () => {
    const fixture = setup({ ...snapshot('sol'), state: 'frozen', eventEpoch: 1n });

    await fixture.reconciler.reconcile({
      marketId: MARKET_ID, custodyMode: 'escrow', marketPda: 'market-a', vaultPda: 'vault-a', asset: 'sol',
    });

    expect(fixture.checks[0]?.details).toMatchObject({ chainState: 'frozen', eventEpoch: '1' });
  });

  it('rejects wrong program, mint, and legacy custody snapshots', async () => {
    // Given substituted account identities
    const wrongProgram = setup({ ...snapshot('sol'), ownerProgramId: '11111111111111111111111111111111' });
    const wrongMint = setup({ ...snapshot('usdc'), tokenMint: 'fake-mint' });
    const valid = setup(snapshot('sol'));

    // When reconciliation runs, then every cross-domain identity fails closed
    await expect(wrongProgram.reconciler.reconcile({
      marketId: MARKET_ID, custodyMode: 'escrow', marketPda: 'market-a', vaultPda: 'vault-a', asset: 'sol',
    })).rejects.toBeInstanceOf(EscrowReconciliationError);
    await expect(wrongMint.reconciler.reconcile({
      marketId: MARKET_ID, custodyMode: 'escrow', marketPda: 'market-a', vaultPda: 'vault-a', asset: 'usdc',
    })).rejects.toBeInstanceOf(EscrowReconciliationError);
    await expect(valid.reconciler.reconcile({
      marketId: MARKET_ID, custodyMode: 'legacy', marketPda: 'market-a', vaultPda: 'vault-a', asset: 'sol',
    })).rejects.toBeInstanceOf(EscrowReconciliationError);
  });
});
