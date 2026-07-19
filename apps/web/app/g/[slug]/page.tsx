import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BoardMarketRow, ReceiptRow } from '@/components/receipt-row';
import { AwaitingConfiguration, DataUnavailable } from '@/components/states';
import { Badge, Card, PageShell, SectionTitle } from '@/components/ui';
import { fetchGroupBoard, fetchGroupReceipts } from '@/lib/queries';
import type { PublicGroupBoardMarket } from '@/lib/receipts';
import { createAnonServerClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Group board' };

const PUBLIC_GROUP_SLUG = /^[A-Za-z0-9_-]{1,80}$/;

function isActiveMarket(market: PublicGroupBoardMarket): boolean {
  return market.status !== 'settled' && market.status !== 'voided';
}

export default async function GroupPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!PUBLIC_GROUP_SLUG.test(slug)) notFound();

  const client = createAnonServerClient();
  if (!client) return <AwaitingConfiguration />;

  const [boardResult, receiptResult] = await Promise.all([
    fetchGroupBoard(client, slug),
    fetchGroupReceipts(client, slug),
  ]);
  if (!boardResult.ok || !receiptResult.ok) return <DataUnavailable retryHref={`/g/${slug}`} />;
  if (!boardResult.data) {
    if (receiptResult.data) return <DataUnavailable retryHref={`/g/${slug}`} />;
    notFound();
  }

  const activeMarkets = boardResult.data.filter(isActiveMarket);
  const recentReceipts = (receiptResult.data ?? []).filter(
    (receipt) => receipt.status === 'settled' || receipt.status === 'voided',
  );
  const latestReceipt = recentReceipts[0] ?? receiptResult.data?.[0] ?? null;

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
          {activeMarkets.length === 0 ? (
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
          {latestReceipt ? (
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
        {recentReceipts.length === 0 ? (
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
