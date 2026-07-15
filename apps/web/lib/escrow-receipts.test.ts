import { describe, expect, it } from 'vitest';
import {
  assembleEscrowReceipts,
  escrowAggregateFromRow,
  escrowClaimTransactionFromRow,
  escrowReceiptFromRow,
  explorerTransactionUrlForCluster,
} from './escrow-receipts';

const MARKET_ID = '4dcb8872-2f1e-4bc5-9b43-1a2b3c4d5e6f';
const ADDRESS = '11111111111111111111111111111111';
const SIGNATURE = '1'.repeat(64);

describe('aggregate escrow public records', () => {
  it.each(['sol', 'usdc'] as const)('assembles finalized %s totals and claims', (asset) => {
    const assembled = assembleEscrowReceipts(
      [receiptRow({ asset })],
      [aggregateRow({ asset, side: 'back', amount_atomic: asset === 'sol' ? '10000000' : '2500000' })],
      [claimRow({ asset, claim_kind: 'payout', amount_atomic: asset === 'sol' ? '19000000' : '4750000' })],
    );
    expect(assembled).toHaveLength(1);
    expect(assembled?.[0]).toMatchObject({
      marketId: MARKET_ID,
      asset,
      payoutTotalAtomic: asset === 'sol' ? '19000000' : '4750000',
      refundTotalAtomic: '0',
    });
  });

  it('coalesces exact duplicates and rejects conflicting duplicates', () => {
    expect(assembleEscrowReceipts(
      [receiptRow(), receiptRow()],
      [aggregateRow(), aggregateRow()],
      [claimRow(), claimRow()],
    )).toHaveLength(1);
    expect(assembleEscrowReceipts(
      [receiptRow(), receiptRow({ vault_pda: 'Vote111111111111111111111111111111111111111' })],
      [],
      [],
    )).toBeNull();
  });

  it('rejects absent, malformed, and cross-asset rows', () => {
    expect(escrowReceiptFromRow(null)).toBeNull();
    expect(escrowReceiptFromRow(receiptRow({ document_hash_hex: 'bad' }))).toBeNull();
    expect(escrowAggregateFromRow(aggregateRow({ amount_atomic: '-1' }))).toBeNull();
    expect(escrowClaimTransactionFromRow(claimRow({ recipient_count: 'many' }))).toBeNull();
    expect(assembleEscrowReceipts(
      [receiptRow({ asset: 'sol' })],
      [aggregateRow({ asset: 'usdc' })],
      [],
    )).toBeNull();
  });

  it('drops identity-shaped source fields from every public mapped result', () => {
    const secret = 'private-wallet-and-telegram-identity';
    const assembled = assembleEscrowReceipts(
      [receiptRow({ owner_pubkey: secret, telegram_user_id: secret, provider_user_id: secret })],
      [aggregateRow({ participant_name: secret })],
      [claimRow({ destination_pubkey: secret, wallet_id: secret })],
    );
    expect(JSON.stringify(assembled)).not.toContain(secret);
    expect(assembled?.[0]).not.toHaveProperty('ownerPubkey');
  });

  it('uses cluster-correct explorer links and none for localnet', () => {
    expect(explorerTransactionUrlForCluster(SIGNATURE, 'devnet')).toContain('cluster=devnet');
    expect(explorerTransactionUrlForCluster(SIGNATURE, 'mainnet-beta')).not.toContain('cluster=');
    expect(explorerTransactionUrlForCluster(SIGNATURE, 'localnet')).toBeNull();
  });
});

function receiptRow(overrides: Record<string, unknown> = {}) {
  return {
    market_id: MARKET_ID,
    group_slug: 'called-it-testers',
    web_enabled: true,
    cluster: 'devnet',
    program_id: ADDRESS,
    market_pda: ADDRESS,
    vault_pda: ADDRESS,
    asset: 'sol',
    document_hash_hex: 'ab'.repeat(32),
    initialize_signature: SIGNATURE,
    initialize_slot: '100',
    outcome: 'claim_won',
    settlement_signature: '2'.repeat(64),
    settlement_slot: '200',
    evidence_hash_hex: 'cd'.repeat(32),
    settled_at: '2030-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function aggregateRow(overrides: Record<string, unknown> = {}) {
  return {
    market_id: MARKET_ID,
    cluster: 'devnet',
    asset: 'sol',
    side: 'back',
    state: 'active',
    lot_count: '2',
    amount_atomic: '10000000',
    ...overrides,
  };
}

function claimRow(overrides: Record<string, unknown> = {}) {
  return {
    market_id: MARKET_ID,
    cluster: 'devnet',
    claim_signature: '3'.repeat(64),
    claim_slot: '300',
    claimed_at: '2030-01-01T00:01:00.000Z',
    asset: 'sol',
    claim_kind: 'payout',
    recipient_count: '1',
    amount_atomic: '19000000',
    ...overrides,
  };
}
