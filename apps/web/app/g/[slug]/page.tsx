import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ReceiptRow } from '@/components/receipt-row';
import { AwaitingConfiguration, DataUnavailable } from '@/components/states';
import { Badge, Card, PageShell, SectionTitle } from '@/components/ui';
import { formatMultiplier, formatRep } from '@/lib/format';
import { fetchGroupBoard } from '@/lib/queries';
import type { PublicReceipt } from '@/lib/receipts';
import { createAnonServerClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'The Table' };

/** Slugs are unguessable tokens; anything absurd is a guaranteed miss. */
const MAX_SLUG_LENGTH = 80;

const PODIUM_GLYPHS = ['🥇', '🥈', '🥉'] as const;
const STREAK_MINIMUM_TO_SHOW = 2;

function HallOfCallsEntry({ receipt, rank }: { receipt: PublicReceipt; rank: number }) {
  return (
    <Link
      href={`/r/${receipt.marketId}`}
      className="flex items-center gap-4 rounded-xl border border-line/70 bg-night-800/50 px-4 py-3 transition-colors hover:border-pitch-500/50"
    >
      <span className="display-type w-8 text-2xl text-fog" aria-hidden>
        {PODIUM_GLYPHS[rank] ?? `#${rank + 1}`}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-chalk">
          “{receipt.quotedText}”
        </span>
        <span className="block text-[11px] text-fog">{receipt.claimerName}</span>
      </span>
      <span className="display-type text-3xl text-pitch-300">
        {formatMultiplier(receipt.quoteMultiplier)}
      </span>
    </Link>
  );
}

export default async function GroupPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!slug || slug.length > MAX_SLUG_LENGTH) notFound();

  const client = createAnonServerClient();
  if (!client) return <AwaitingConfiguration />;

  const boardResult = await fetchGroupBoard(client, slug);
  if (!boardResult.ok) return <DataUnavailable />;
  const board = boardResult.data;
  if (!board) notFound();

  return (
    <PageShell topRight={<Badge tone="pitch">Group board</Badge>}>
      <div className="mt-2">
        <h1 className="display-type text-5xl text-chalk">The Table</h1>
        <p className="mt-2 text-sm text-fog">
          Every call, every receipt, every grudge — kept honest by the ledger.
        </p>
      </div>

      {/* Leaderboard */}
      <Card>
        <SectionTitle>Standings</SectionTitle>
        {board.leaderboard.length === 0 ? (
          <p className="mt-3 text-sm text-fog">No Rep on the board yet — first call sets the tone.</p>
        ) : (
          <ol className="mt-3 divide-y divide-line/60">
            {board.leaderboard.map((entry, index) => (
              <li key={`${entry.displayName}-${index}`} className="flex items-center gap-3 py-2.5">
                <span className="display-type w-8 shrink-0 text-right text-lg text-fog">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-chalk">
                  {entry.displayName}
                  {entry.streak >= STREAK_MINIMUM_TO_SHOW ? (
                    <span className="ml-2 text-xs text-flood-300">🔥 {entry.streak} straight</span>
                  ) : null}
                </span>
                <span className="display-type text-xl text-chalk">
                  {formatRep(entry.points)}
                  <span className="ml-1 text-xs text-fog">Rep</span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </Card>

      {/* Hall of Calls */}
      <Card>
        <SectionTitle>Hall of Calls</SectionTitle>
        <p className="mt-1 text-[11px] text-fog/80">
          The five gutsiest settled calls this group ever landed on the record.
        </p>
        {board.hallOfCalls.length === 0 ? (
          <p className="mt-3 text-sm text-fog">
            Empty for now — somebody make a call worth framing.
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            {board.hallOfCalls.map((receipt, index) => (
              <HallOfCallsEntry key={receipt.marketId} receipt={receipt} rank={index} />
            ))}
          </div>
        )}
      </Card>

      {/* Recent receipts */}
      <Card>
        <SectionTitle>Recent receipts</SectionTitle>
        {board.recentReceipts.length === 0 ? (
          <p className="mt-3 text-sm text-fog">Nothing on the record yet.</p>
        ) : (
          <div className="mt-2 -mx-2">
            {board.recentReceipts.map((receipt) => (
              <ReceiptRow key={receipt.marketId} receipt={receipt} />
            ))}
          </div>
        )}
      </Card>
    </PageShell>
  );
}
