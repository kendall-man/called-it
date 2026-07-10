import { Badge, Card, PageShell } from '@/components/ui';

export default function Loading() {
  return (
    <PageShell topRight={<Badge tone="neutral">Receipt</Badge>}>
      <Card className="animate-pulse">
        <div className="h-3 w-24 rounded bg-night-700" />
        <div className="mt-4 h-10 w-4/5 rounded bg-night-700" />
        <div className="mt-3 h-4 w-1/3 rounded bg-night-800" />
      </Card>
      <Card className="animate-pulse">
        <div className="h-3 w-32 rounded bg-night-700" />
        <div className="mt-4 h-16 rounded bg-night-800" />
      </Card>
    </PageShell>
  );
}
