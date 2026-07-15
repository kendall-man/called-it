import { describe, expect, it } from 'vitest';
import { DEVNET_ESCROW_PROGRAM_ID } from '@calledit/escrow-sdk';
import {
  ESCROW_GENESIS_BY_NETWORK,
  assembleEscrowReceipts,
  escrowAggregateFromRow,
  escrowClaimTransactionFromRow,
  escrowReceiptFromRow,
  explorerTransactionUrlForCluster,
  getPublicEscrowIdentityConfig,
  publicReceiptFromEscrow,
  type PublicEscrowIdentityConfig,
} from './escrow-receipts';

const MARKET_ID = '4dcb8872-2f1e-4bc5-9b43-1a2b3c4d5e6f';
const ADDRESS = '11111111111111111111111111111111';
const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const SIGNATURE = '1'.repeat(64);
const IDENTITY: PublicEscrowIdentityConfig = {
  network: 'devnet',
  genesisHash: ESCROW_GENESIS_BY_NETWORK.devnet,
  programId: ADDRESS,
  canonicalUsdcMint: USDC_MINT,
};

describe('standalone aggregate escrow public records', () => {
  it.each(['sol', 'usdc'] as const)('assembles finalized %s totals and claims', (asset) => {
    const assembled = assembleEscrowReceipts(
      [receiptRow({
        asset,
        currency: asset,
        mint_pubkey: asset === 'usdc' ? USDC_MINT : null,
      })],
      [aggregateRow({ asset, side: 'back', amount_atomic: asset === 'sol' ? '10000000' : '2500000' })],
      [claimRow({ asset, claim_kind: 'payout', amount_atomic: asset === 'sol' ? '19000000' : '4750000' })],
      IDENTITY,
    );
    expect(assembled).toHaveLength(1);
    expect(assembled?.[0]).toMatchObject({
      marketId: MARKET_ID,
      asset,
      fixtureId: 42,
      status: 'settled',
      payoutTotalAtomic: asset === 'sol' ? '19000000' : '4750000',
      refundTotalAtomic: '0',
    });
  });

  it('derives receipt totals and counts only from aggregate and claim rows', () => {
    const [escrow] = assembleEscrowReceipts(
      [receiptRow()],
      [
        aggregateRow({ side: 'back', state: 'active', lot_count: '2', amount_atomic: '10000000' }),
        aggregateRow({ side: 'doubt', state: 'active', lot_count: '3', amount_atomic: '15000000' }),
        aggregateRow({ side: 'back', state: 'refundable', lot_count: '1', amount_atomic: '2000000' }),
      ],
      [claimRow({ claim_kind: 'payout', amount_atomic: '24000000' })],
      IDENTITY,
    ) ?? [];
    expect(escrow).toBeDefined();
    const receipt = escrow ? publicReceiptFromEscrow(escrow) : null;
    expect(receipt).toMatchObject({
      backPotLamports: '12000000',
      doubtPotLamports: '15000000',
      matchedAmountLamports: '25000000',
      refundedAmountLamports: '0',
      paidAmountLamports: '24000000',
      positionCount: 6,
    });
  });

  it('coalesces exact duplicates and rejects conflicting duplicates', () => {
    expect(assembleEscrowReceipts(
      [receiptRow(), receiptRow()],
      [aggregateRow(), aggregateRow()],
      [claimRow(), claimRow()],
      IDENTITY,
    )).toHaveLength(1);
    expect(assembleEscrowReceipts(
      [receiptRow(), receiptRow({ fixture_p2_name: 'Conflicting FC' })],
      [],
      [],
      IDENTITY,
    )).toBeNull();
  });

  it('rejects malformed deployment identities and asset/mint mismatches', () => {
    expect(escrowReceiptFromRow(receiptRow(), IDENTITY)).not.toBeNull();
    expect(escrowReceiptFromRow(receiptRow({ genesis_hash: 'wrong-genesis' }), IDENTITY)).toBeNull();
    expect(escrowReceiptFromRow(receiptRow({ program_id: 'Vote111111111111111111111111111111111111111' }), IDENTITY)).toBeNull();
    expect(escrowReceiptFromRow(receiptRow({ cluster: 'mainnet-beta' }), IDENTITY)).toBeNull();
    expect(escrowReceiptFromRow(receiptRow({ mint_pubkey: USDC_MINT }), IDENTITY)).toBeNull();
    expect(escrowReceiptFromRow(receiptRow({
      asset: 'usdc',
      currency: 'usdc',
      mint_pubkey: ADDRESS,
    }), IDENTITY)).toBeNull();
  });

  it('accepts the compiled devnet identity and preserves devnet receipts', () => {
    const identity = getPublicEscrowIdentityConfig({
      NEXT_PUBLIC_SOLANA_NETWORK: 'devnet',
      NEXT_PUBLIC_ESCROW_GENESIS_HASH: ESCROW_GENESIS_BY_NETWORK.devnet,
      NEXT_PUBLIC_ESCROW_PROGRAM_ID: DEVNET_ESCROW_PROGRAM_ID,
      NEXT_PUBLIC_ESCROW_CANONICAL_USDC_MINT: USDC_MINT,
    });

    expect(identity).toEqual({
      network: 'devnet',
      genesisHash: ESCROW_GENESIS_BY_NETWORK.devnet,
      programId: DEVNET_ESCROW_PROGRAM_ID,
      canonicalUsdcMint: USDC_MINT,
    });
    expect(identity && escrowReceiptFromRow(
      receiptRow({ program_id: DEVNET_ESCROW_PROGRAM_ID }),
      identity,
    )).not.toBeNull();
  });

  it('rejects configured identities that do not match the compiled network identity', () => {
    expect(getPublicEscrowIdentityConfig({
      NEXT_PUBLIC_SOLANA_NETWORK: 'devnet',
      NEXT_PUBLIC_ESCROW_GENESIS_HASH: ESCROW_GENESIS_BY_NETWORK.devnet,
      NEXT_PUBLIC_ESCROW_PROGRAM_ID: ADDRESS,
    })).toBeNull();
    expect(getPublicEscrowIdentityConfig({
      NEXT_PUBLIC_SOLANA_NETWORK: 'mainnet-beta',
      NEXT_PUBLIC_ESCROW_GENESIS_HASH: ESCROW_GENESIS_BY_NETWORK['mainnet-beta'],
      NEXT_PUBLIC_ESCROW_PROGRAM_ID: ADDRESS,
      NEXT_PUBLIC_ESCROW_CANONICAL_USDC_MINT: USDC_MINT,
    })).toBeNull();
    expect(getPublicEscrowIdentityConfig({
      NEXT_PUBLIC_SOLANA_NETWORK: 'mainnet-beta',
      NEXT_PUBLIC_ESCROW_GENESIS_HASH: ESCROW_GENESIS_BY_NETWORK.devnet,
      NEXT_PUBLIC_ESCROW_PROGRAM_ID: ADDRESS,
    })).toBeNull();
  });

  it('rejects absent, malformed, cross-asset, and impossible claim rows', () => {
    expect(escrowReceiptFromRow(null, IDENTITY)).toBeNull();
    expect(escrowReceiptFromRow(receiptRow({ document_hash_hex: 'bad' }), IDENTITY)).toBeNull();
    expect(escrowAggregateFromRow(aggregateRow({ amount_atomic: '-1' }))).toBeNull();
    expect(escrowClaimTransactionFromRow(claimRow({ recipient_count: 'many' }))).toBeNull();
    expect(assembleEscrowReceipts(
      [receiptRow({ status: 'open', chain_state: 'open', outcome: null, settlement_signature: null,
        settlement_instruction_index: null, settlement_slot: null, evidence_hash_hex: null, settled_at: null })],
      [],
      [claimRow()],
      IDENTITY,
    )).toBeNull();
    expect(assembleEscrowReceipts(
      [receiptRow({ asset: 'sol' })],
      [aggregateRow({ asset: 'usdc' })],
      [],
      IDENTITY,
    )).toBeNull();
  });

  it('drops fixture snapshots and identity-shaped extras from public mapped results', () => {
    const secret = 'private-wallet-and-telegram-identity';
    const assembled = assembleEscrowReceipts(
      [receiptRow({ owner_pubkey: secret, telegram_user_id: secret, provider_user_id: secret })],
      [aggregateRow({ participant_name: secret })],
      [claimRow({ destination_pubkey: secret, wallet_id: secret })],
      IDENTITY,
    );
    expect(JSON.stringify(assembled)).not.toContain(secret);
    expect(assembled?.[0]).not.toHaveProperty('fixtureP1Name');
    expect(assembled?.[0]).not.toHaveProperty('fixtureP2Name');
    expect(assembled?.[0]).not.toHaveProperty('ownerPubkey');
  });

  it('uses cluster-correct explorer links and none for localnet', () => {
    expect(explorerTransactionUrlForCluster(SIGNATURE, 'devnet')).toContain('cluster=devnet');
    expect(explorerTransactionUrlForCluster(SIGNATURE, 'mainnet-beta')).not.toContain('cluster=');
    expect(explorerTransactionUrlForCluster(SIGNATURE, 'localnet')).toBeNull();
  });
});

export function receiptRow(overrides: Record<string, unknown> = {}) {
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
    fixture_id: 42,
    fixture_p1_name: 'North FC',
    fixture_p2_name: 'South FC',
    spec: {
      claimType: 'match_winner',
      fixtureId: 42,
      entityRef: { kind: 'team', participant: 1, name: 'North FC' },
      comparator: 'eq',
      threshold: 1,
      period: 'FT',
      trustTier: 'chain_proven',
    },
    is_replay: false,
    kickoff_at: '2030-01-01T12:00:00.000Z',
    created_at: '2029-12-01T00:00:00.000Z',
    price_provenance: 'market',
    quote_probability: 0.4,
    quote_multiplier: 2.5,
    probability_ppm: '400000',
    ratio_milli: '1500',
    currency: 'sol',
    genesis_hash: ESCROW_GENESIS_BY_NETWORK.devnet,
    mint_pubkey: null,
    custody_version: 1,
    chain_state: 'settled',
    initialize_instruction_index: 0,
    initialize_block_time: '2029-12-01T00:01:00.000Z',
    settlement_instruction_index: 1,
    status: 'settled',
    ...overrides,
  };
}

export function aggregateRow(overrides: Record<string, unknown> = {}) {
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

export function claimRow(overrides: Record<string, unknown> = {}) {
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
