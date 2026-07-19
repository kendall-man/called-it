import Link from 'next/link';
import { Badge, Card, PageShell } from '@/components/ui';

export default function NotFound() {
  return (
    <PageShell topRight={<Badge tone="neutral">404</Badge>}>
      <Card className="mt-10 text-center">
        <p className="display-type text-3xl text-chalk">Nothing here</p>
        <p className="mt-3 text-sm leading-relaxed text-fog">
          This link may be old, or the group keeps this receipt private.
        </p>
        <Link
          href="/"
          className="mt-5 inline-flex min-h-11 items-center border border-line bg-night-800 px-4 font-mono text-sm text-chalk hover:border-pitch-500"
        >
          Back to Rumble
        </Link>
      </Card>
    </PageShell>
  );
}
