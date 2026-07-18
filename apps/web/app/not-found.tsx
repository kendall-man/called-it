import Link from 'next/link';
import { Badge, Card, PageShell } from '@/components/ui';

export default function NotFound() {
  return (
    <PageShell topRight={<Badge tone="neutral">404</Badge>}>
      <Card className="mt-10 text-center">
        <p className="display-type text-3xl text-chalk">Nothing on the record here</p>
        <p className="mt-3 text-sm leading-relaxed text-fog">
          This page doesn’t exist — or the group keeps its receipts private. Either way, no call
          to see.
        </p>
        <Link
          href="/"
          className="display-type mt-5 inline-block rounded-xl border border-line bg-night-800 px-4 py-2 text-sm text-chalk hover:border-pitch-500/50"
        >
          Back to Rumble
        </Link>
      </Card>
    </PageShell>
  );
}
