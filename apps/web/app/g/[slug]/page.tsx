import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ReceiptRow } from '@/components/receipt-row';
import { AwaitingConfiguration, DataUnavailable } from '@/components/states';
import { Badge, Card, PageShell, SectionTitle } from '@/components/ui';
import { fetchGroupReceipts } from '@/lib/queries';
import { createAnonServerClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'On the record' };

/** Slugs are unguessable tokens; anything absurd is a guaranteed miss. */
const MAX_SLUG_LENGTH = 80;

export default async function GroupPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!slug || slug.length > MAX_SLUG_LENGTH) notFound();

  const client = createAnonServerClient();
  if (!client) return <AwaitingConfiguration />;

  const result = await fetchGroupReceipts(client, slug);
  if (!result.ok) return <DataUnavailable />;
  const receipts = result.data;
  if (!receipts) notFound();

  return (
    <PageShell topRight={<Badge tone="pitch">Group ledger</Badge>}>
      <div className="mt-2">
        <h1 className="display-type text-5xl text-chalk">On the record</h1>
        <p className="mt-2 text-sm text-fog">
          Every call this group has put on the record — priced off the live feed, backed or bet
          against in devnet SOL, and settled without arguments.
        </p>
      </div>

      <Card>
        <SectionTitle>The calls</SectionTitle>
        {receipts.length === 0 ? (
          <p className="mt-3 text-sm text-fog">Nothing on the record yet.</p>
        ) : (
          <div className="mt-2 -mx-2">
            {receipts.map((receipt) => (
              <ReceiptRow key={receipt.marketId} receipt={receipt} />
            ))}
          </div>
        )}
      </Card>
    </PageShell>
  );
}
