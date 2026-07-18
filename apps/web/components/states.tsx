/** Full-card degraded states: unconfigured deploy and data-source hiccups. */
import Link from 'next/link';
import { Card, PageShell, Badge } from './ui';

export function AwaitingConfiguration() {
  return (
    <PageShell topRight={<Badge tone="flood">Warming up</Badge>}>
      <Card className="mt-10 text-center">
        <h1 className="display-type text-3xl text-chalk">Public records are not ready</h1>
        <p className="mt-3 text-sm leading-relaxed text-fog">
          This deployment cannot show public group data yet. No funds moved and no saved call changed.
        </p>
        <Link
          href="/"
          className="display-type mt-5 inline-flex min-h-11 items-center rounded-xl border border-line bg-night-800 px-4 text-sm text-chalk hover:border-pitch-500/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pitch-300"
        >
          Back to Rumble
        </Link>
      </Card>
    </PageShell>
  );
}

export function DataUnavailable({ retryHref }: { retryHref: string }) {
  return (
    <PageShell topRight={<Badge tone="flood">Hold on</Badge>}>
      <Card className="mt-10 text-center">
        <h1 className="display-type text-3xl text-chalk">Public data is unavailable</h1>
        <p className="mt-3 text-sm leading-relaxed text-fog">
          We could not load the current public record. No funds moved and no saved call changed.
        </p>
        <Link
          href={retryHref}
          className="display-type mt-5 inline-flex min-h-11 items-center rounded-xl border border-line bg-night-800 px-4 text-sm text-chalk hover:border-pitch-500/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pitch-300"
        >
          Try again
        </Link>
      </Card>
    </PageShell>
  );
}

export function PublicRecordLoading({ label }: { label: 'group board' | 'receipt' }) {
  return (
    <PageShell topRight={<Badge tone="neutral">Loading</Badge>}>
      <Card className="mt-10 text-center" aria-busy="true" aria-live="polite">
        <h1 className="display-type text-3xl text-chalk">Loading public {label}</h1>
        <p className="mt-3 text-sm leading-relaxed text-fog">
          Loading the latest public record. No funds moved and no saved call changed.
        </p>
      </Card>
    </PageShell>
  );
}
