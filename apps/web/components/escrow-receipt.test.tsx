import { renderToStaticMarkup } from 'react-dom/server';
import React, { type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { PublicEscrowReceipt } from '@/lib/escrow-receipts';
import { EscrowBoardSummary, EscrowReceiptDetails } from './escrow-receipt';

vi.mock('./ui', () => ({
  Badge: ({ children }: { readonly children: ReactNode }) => <span>{children}</span>,
}));

describe('escrow receipt components', () => {
  it.each(['sol', 'usdc'] as const)('renders aggregate %s chain evidence without identities', (asset) => {
    const secret = 'private-telegram-wallet-link';
    const receipt = fixture(asset);
    const html = renderToStaticMarkup(
      <>
        <EscrowReceiptDetails escrow={receipt} />
        <EscrowBoardSummary escrow={receipt} />
      </>,
    );
    expect(html).toContain('Finalized escrow record');
    expect(html).toContain(asset.toUpperCase());
    expect(html).toContain('Per-market vault');
    expect(html).toContain('Finalized payouts');
    expect(html).toContain('Aggregate chain data only');
    expect(html).not.toContain(secret);
    expect(html).not.toMatch(/participant name|telegram user|provider user/i);
  });

  it('uses truthful pending settlement language when no finalized settlement exists', () => {
    const receipt = {
      ...fixture('sol'),
      outcome: null,
      settlementSignature: null,
      settlementSlot: null,
      settlementEvidenceHashHex: null,
      settledAt: null,
    } satisfies PublicEscrowReceipt;
    const html = renderToStaticMarkup(<EscrowReceiptDetails escrow={receipt} />);
    expect(html).toContain('Settlement is not finalized yet');
    expect(html).not.toContain('It happens won');
  });
});

function fixture(asset: 'sol' | 'usdc'): PublicEscrowReceipt {
  return {
    marketId: '4dcb8872-2f1e-4bc5-9b43-1a2b3c4d5e6f',
    groupSlug: 'called-it-testers',
    cluster: 'devnet',
    asset,
    programId: '11111111111111111111111111111111',
    marketPda: '11111111111111111111111111111111',
    vaultPda: '11111111111111111111111111111111',
    documentHashHex: 'ab'.repeat(32),
    initializeSignature: '1'.repeat(64),
    initializeSlot: '100',
    outcome: 'claim_won',
    settlementSignature: '2'.repeat(64),
    settlementSlot: '200',
    settlementEvidenceHashHex: 'cd'.repeat(32),
    settledAt: '2030-01-01T00:00:00.000Z',
    aggregates: [{ side: 'back', state: 'active', lotCount: 2, amountAtomic: '10000000' }],
    claimTransactions: [{
      signature: '3'.repeat(64),
      slot: '300',
      claimedAt: '2030-01-01T00:01:00.000Z',
      claimKind: 'payout',
      recipientCount: 1,
      amountAtomic: asset === 'sol' ? '19000000' : '4750000',
    }],
    payoutTotalAtomic: asset === 'sol' ? '19000000' : '4750000',
    refundTotalAtomic: '0',
  };
}
