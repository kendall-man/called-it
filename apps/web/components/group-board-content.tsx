import Link from 'next/link';
import React from 'react';
import type { QueryResult } from '@/lib/queries';
import type { PublicGroupBoardMarket, PublicReceipt } from '@/lib/receipts';
import { BoardMarketRow, ReceiptRow } from './receipt-row';
import { Badge, Card, PageShell, SectionTitle } from './ui';

function isActiveMarket(market: PublicGroupBoardMarket): boolean {
  return market.status !== 'settled' && market.status !== 'voided';
}

export function GroupBoardContent({
  slug,
  boardResult,
  receiptResult,
}: {
  readonly slug: string;
  readonly boardResult: QueryResult<PublicGroupBoardMarket[] | null>;
  readonly receiptResult: QueryResult<PublicReceipt[] | null>;
}) {
  const boardAvailable = boardResult.ok;
  const receiptsAvailable = receiptResult.ok;
  const activeMarkets = (boardResult.ok ? boardResult.data ?? [] : []).filter(isActiveMarket);
  const receipts = receiptResult.ok ? receiptResult.data ?? [] : [];
  const recentReceipts = receipts.filter(
    (receipt) => receipt.status === 'settled' || receipt.status === 'voided',
  );
  const latestReceipt = recentReceipts[0] ?? receipts[0] ?? null;

  return (
    <PageShell width="board" topRight={<Badge tone="pitch">Group board</Badge>}>
      <div>
        <h1 className="display-type text-4xl text-chalk sm:text-5xl">Group board</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-fog">
          The group’s open calls, total SOL and latest results. Individual picks stay private.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <SectionTitle>Open calls</SectionTitle>
          {!boardAvailable ? (
            <SectionUnavailable retryHref={`/g/${slug}`} label="open calls" />
          ) : activeMarkets.length === 0 ? (
            <p className="mt-3 text-sm leading-relaxed text-fog">
              No calls are open right now. Finished calls are below.
            </p>
          ) : (
            <div className="mt-2">
              {activeMarkets.map((market) => (
                <BoardMarketRow key={market.marketId} market={market} />
              ))}
            </div>
          )}
        </Card>

        <Card>
          <SectionTitle>Latest receipt</SectionTitle>
          {!receiptsAvailable ? (
            <SectionUnavailable retryHref={`/g/${slug}`} label="latest receipt" />
          ) : latestReceipt ? (
            <div className="mt-2">
              <ReceiptRow receipt={latestReceipt} />
            </div>
          ) : (
            <p className="mt-3 text-sm leading-relaxed text-fog">
              No receipt yet. Open a call to see where it stands.
            </p>
          )}
        </Card>
      </div>

      <Card>
        <SectionTitle>Recent receipts</SectionTitle>
        {!receiptsAvailable ? (
          <SectionUnavailable retryHref={`/g/${slug}`} label="recent receipts" />
        ) : recentReceipts.length === 0 ? (
          <p className="mt-3 text-sm leading-relaxed text-fog">
            No finished calls yet. Rumble will post the first receipt here after a result.
          </p>
        ) : (
          <div className="mt-2">
            {recentReceipts.map((receipt) => (
              <ReceiptRow key={receipt.marketId} receipt={receipt} />
            ))}
          </div>
        )}
      </Card>
    </PageShell>
  );
}

function SectionUnavailable({ retryHref, label }: { readonly retryHref: string; readonly label: string }) {
  return (
    <p className="mt-3 text-sm leading-relaxed text-fog">
      Rumble couldn’t load {label}.{' '}
      <Link
        href={retryHref}
        className="text-pitch-300 underline decoration-pitch-500/60 underline-offset-4 hover:text-pitch-200"
      >
        Try again
      </Link>
    </p>
  );
}
