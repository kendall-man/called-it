/** Full-card degraded states: unconfigured deploy and data-source hiccups. */
import { Card, PageShell, Badge } from './ui';

export function AwaitingConfiguration() {
  return (
    <PageShell topRight={<Badge tone="flood">Warming up</Badge>}>
      <Card className="mt-10 text-center">
        <p className="display-type text-3xl text-chalk">Studio lights are off</p>
        <p className="mt-3 text-sm leading-relaxed text-fog">
          This page isn’t wired to its data source yet. Once the deploy sets{' '}
          <code className="rounded bg-night-800 px-1.5 py-0.5 text-xs text-chalk">
            NEXT_PUBLIC_SUPABASE_URL
          </code>{' '}
          and{' '}
          <code className="rounded bg-night-800 px-1.5 py-0.5 text-xs text-chalk">
            NEXT_PUBLIC_SUPABASE_ANON_KEY
          </code>
          , the receipts go live.
        </p>
      </Card>
    </PageShell>
  );
}

export function DataUnavailable() {
  return (
    <PageShell topRight={<Badge tone="flood">Hold on</Badge>}>
      <Card className="mt-10 text-center">
        <p className="display-type text-3xl text-chalk">The scoreboard isn’t answering</p>
        <p className="mt-3 text-sm leading-relaxed text-fog">
          Temporary glitch on our side of the tunnel. Give it a minute and refresh — every call
          and receipt is safe.
        </p>
      </Card>
    </PageShell>
  );
}
