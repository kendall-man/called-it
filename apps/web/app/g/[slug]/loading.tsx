import { Badge, Card, PageShell } from '@/components/ui';

export default function Loading() {
  return (
    <PageShell topRight={<Badge tone="pitch">Group ledger</Badge>}>
      <div className="animate-pulse">
        <div className="h-12 w-3/5 rounded bg-night-700" />
        <div className="mt-3 h-4 w-full rounded bg-night-800" />
      </div>
      <Card className="animate-pulse">
        <div className="h-3 w-20 rounded bg-night-700" />
        <div className="mt-4 space-y-3">
          <div className="h-14 rounded bg-night-800" />
          <div className="h-14 rounded bg-night-800" />
          <div className="h-14 rounded bg-night-800" />
        </div>
      </Card>
    </PageShell>
  );
}
