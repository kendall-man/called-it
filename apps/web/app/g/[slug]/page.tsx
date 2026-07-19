import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { GroupBoardContent } from '@/components/group-board-content';
import { AwaitingConfiguration, DataUnavailable } from '@/components/states';
import { fetchGroupBoard, fetchGroupReceipts } from '@/lib/queries';
import { createAnonServerClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Group board' };

const PUBLIC_GROUP_SLUG = /^[A-Za-z0-9_-]{1,80}$/;

export default async function GroupPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!PUBLIC_GROUP_SLUG.test(slug)) notFound();

  const client = createAnonServerClient();
  if (!client) return <AwaitingConfiguration />;

  const [boardResult, receiptResult] = await Promise.all([
    fetchGroupBoard(client, slug),
    fetchGroupReceipts(client, slug),
  ]);
  if (!boardResult.ok && !receiptResult.ok) return <DataUnavailable retryHref={`/g/${slug}`} />;
  if (boardResult.ok && receiptResult.ok && !boardResult.data && !receiptResult.data) notFound();

  return <GroupBoardContent slug={slug} boardResult={boardResult} receiptResult={receiptResult} />;
}
