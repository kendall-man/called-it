/** Full-card degraded states: unconfigured deploy and data-source hiccups. */
import Link from 'next/link';
import { Card, PageShell, Badge } from './ui';

export function AwaitingConfiguration() {
  return (
    <PageShell topRight={<Badge tone="flood">Warming up</Badge>}>
      <Card className="mt-10 text-center">
        <h1 className="display-type text-3xl text-chalk">Public records are not ready</h1>
        <p className="mt-3 text-sm leading-relaxed text-fog">
          Rumble can’t show this group yet. No SOL moved and the call is unchanged.
        </p>
        <Link
          href="/"
          className="mt-5 inline-flex min-h-11 items-center border border-line bg-night-800 px-4 font-mono text-sm text-chalk hover:border-pitch-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pitch-300"
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
          Rumble couldn’t load this page. No SOL moved and the call is unchanged.
        </p>
        <Link
          href={retryHref}
          className="mt-5 inline-flex min-h-11 items-center border border-line bg-night-800 px-4 font-mono text-sm text-chalk hover:border-pitch-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pitch-300"
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
          Getting the latest {label}.
        </p>
      </Card>
    </PageShell>
  );
}
