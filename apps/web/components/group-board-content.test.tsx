import { renderToStaticMarkup } from 'react-dom/server';
import React, { type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { PublicGroupBoardMarket, PublicReceipt } from '@/lib/receipts';
import { GroupBoardContent } from './group-board-content';

vi.mock('./receipt-row', () => ({
  BoardMarketRow: ({ market }: { market: PublicGroupBoardMarket }) => <p>{market.terms.text}</p>,
  ReceiptRow: ({ receipt }: { receipt: PublicReceipt }) => (
    <p>{receipt.terms.text} · {receipt.outcome === 'claim_won' ? 'Yes won' : receipt.status}</p>
  ),
}));

vi.mock('./ui', () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Card: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  PageShell: ({ children, topRight }: { children: ReactNode; topRight: ReactNode }) => (
    <main>{topRight}{children}</main>
  ),
  SectionTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

const MARKET_ID = '4dcb8872-2f1e-4bc5-9b43-1a2b3c4d5e6f';

describe('group board source isolation', () => {
  it('keeps open calls visible when receipts are unavailable', () => {
    const html = renderToStaticMarkup(
      <GroupBoardContent
        slug="called-it-testers"
        boardResult={{ ok: true, data: [boardMarket()] }}
        receiptResult={{ ok: false }}
      />,
    );

    expect(html).toContain('North FC to win');
    expect(html).toContain('Rumble couldn’t load latest receipt');
    expect(html).toContain('Rumble couldn’t load recent receipts');
    expect(html).not.toContain('Public data is unavailable');
  });

  it('keeps receipts visible when the aggregate board is unavailable', () => {
    const html = renderToStaticMarkup(
      <GroupBoardContent
        slug="called-it-testers"
        boardResult={{ ok: false }}
        receiptResult={{ ok: true, data: [receipt()] }}
      />,
    );

    expect(html).toContain('Rumble couldn’t load open calls');
    expect(html).toContain('North FC to win');
    expect(html).toContain('Yes won');
    expect(html).not.toContain('Public data is unavailable');
  });
});

function boardMarket(): PublicGroupBoardMarket {
  return {
    ...publicMarket(),
    status: 'open',
    outcome: null,
    settledAt: null,
  };
}

function receipt(): PublicReceipt {
  return {
    ...publicMarket(),
    status: 'settled',
    outcome: 'claim_won',
    settledAt: '2030-01-01T14:00:00.000Z',
    decidingSeq: 100,
    evidenceSeqs: [100],
    tier: 'chain_proven',
    proofStatus: 'verified',
    explorerUrl: null,
    browserProof: null,
  };
}

function publicMarket() {
  return {
    marketId: MARKET_ID,
    groupSlug: 'called-it-testers',
    terms: {
      fixtureId: 42,
      text: 'North FC to win',
      period: 'Full time',
      trustTier: 'chain_proven' as const,
    },
    currency: 'sol' as const,
    priceProvenance: 'market' as const,
    quoteProbability: 0.5,
    quoteMultiplier: 2,
    backPotLamports: '10000000',
    doubtPotLamports: '10000000',
    matchedAmountLamports: '20000000',
    refundedAmountLamports: '0',
    paidAmountLamports: '19000000',
    positionCount: 2,
    createdAt: '2030-01-01T12:00:00.000Z',
  };
}
