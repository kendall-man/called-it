import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { EvidenceList } from '@/components/evidence-list';
import { AwaitingConfiguration, DataUnavailable } from '@/components/states';
import { TimelineList } from '@/components/timeline-list';
import { TrustBadge, type TrustSnapshot } from '@/components/trust-badge';
import { Badge, Card, PageShell, SectionTitle } from '@/components/ui';
import { formatLamportsAsSol, formatMultiplier, formatProbabilityPct } from '@/lib/format';
import { fetchEvidence, fetchReceipt } from '@/lib/queries';
import type { EvidenceFact, PublicReceipt } from '@/lib/receipts';
import {
  describePeriod,
  describeTerms,
  parseMarketSpec,
  PROVENANCE_COPY,
} from '@/lib/spec-terms';
import { createAnonServerClient } from '@/lib/supabase';
import { buildTimeline } from '@/lib/timeline';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Receipt' };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OUTCOME_BANNER: Record<
  NonNullable<PublicReceipt['outcome']>,
  { className: string; label: string }
> = {
  claim_won: { className: 'bg-pitch-500 text-night-950', label: 'Called it ✓' },
  claim_lost: { className: 'bg-siren-500 text-night-950', label: 'Didn’t land' },
  void: { className: 'bg-night-700 text-chalk', label: 'Void — stakes returned' },
};

export default async function ReceiptPage({
  params,
}: {
  params: Promise<{ marketId: string }>;
}) {
  const { marketId } = await params;
  if (!UUID_PATTERN.test(marketId)) notFound();

  const client = createAnonServerClient();
  if (!client) return <AwaitingConfiguration />;

  const receiptResult = await fetchReceipt(client, marketId);
  if (!receiptResult.ok) return <DataUnavailable />;
  const receipt = receiptResult.data;
  if (!receipt) notFound();

  const spec = parseMarketSpec(receipt.spec);

  const evidenceSeqs = [
    ...new Set(
      receipt.decidingSeq !== null
        ? [...receipt.evidenceSeqs, receipt.decidingSeq]
        : receipt.evidenceSeqs,
    ),
  ];
  let evidence: EvidenceFact[] = [];
  if (spec && evidenceSeqs.length > 0) {
    const evidenceResult = await fetchEvidence(client, spec.fixtureId, evidenceSeqs);
    if (evidenceResult.ok) evidence = evidenceResult.data;
  }

  const provenance = PROVENANCE_COPY[receipt.priceProvenance];
  const banner = receipt.outcome ? OUTCOME_BANNER[receipt.outcome] : null;
  const trustSnapshot: TrustSnapshot = {
    status: receipt.status,
    tier: receipt.tier,
    proofStatus: receipt.proofStatus,
    explorerUrl: receipt.explorerUrl,
    settledAt: receipt.settledAt,
    merkleProof: receipt.merkleProof,
  };

  return (
    <PageShell topRight={<Badge tone="neutral">Receipt</Badge>}>
      {/* Outcome banner — the match-night punchline. */}
      {banner ? (
        <div
          className={`display-type rounded-2xl px-5 py-3 text-center text-2xl ${banner.className}`}
        >
          {banner.label}
        </div>
      ) : null}

      {/* Alias-only attribution and deterministic terms; raw claim text never reaches this route. */}
      <Card>
        <p className="display-type text-xs tracking-[0.25em] text-fog">On the record</p>
        <div className="mt-2">
          <p className="display-type text-3xl leading-tight text-chalk sm:text-4xl">
            {spec ? describeTerms(spec) : 'Recorded call terms'}
          </p>
          <p className="mt-3 text-sm text-fog">
            {receipt.claimerAlias}
          </p>
        </div>
      </Card>

      {/* Terms in plain English */}
      <Card>
        <SectionTitle>The call, on paper</SectionTitle>
        {spec ? (
          <>
            <p className="mt-2 text-lg font-bold text-chalk">{describeTerms(spec)}</p>
            <p className="mt-1 text-sm text-fog">{describePeriod(spec.period)}</p>
          </>
        ) : (
          <p className="mt-2 text-sm text-fog">
            Terms unavailable in a readable form — the verdict below still stands.
          </p>
        )}
      </Card>

      {/* Price + provenance */}
      <Card>
        <SectionTitle>The price at the moment</SectionTitle>
        <div className="mt-3 flex items-end justify-between gap-4">
          <div>
            <p className="display-type text-5xl text-chalk">
              {formatMultiplier(receipt.quoteMultiplier)}
              <span className="ml-2 text-2xl text-pitch-400">back</span>
            </p>
            <p className="mt-1 text-sm text-fog">
              Data said {formatProbabilityPct(receipt.quoteProbability)} when the call was made
            </p>
          </div>
          <Badge tone={receipt.priceProvenance === 'market' ? 'pitch' : 'flood'}>
            {provenance.label}
          </Badge>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-fog">
          {provenance.blurb} Backers and doubters each locked their own multiplier at tap time, in
          devnet SOL — test tokens, not real money.
        </p>
      </Card>

      <Card>
        <SectionTitle>Group activity</SectionTitle>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-fog">Happens pot</dt>
            <dd className="mt-1 font-semibold text-chalk">
              {formatLamportsAsSol(receipt.backPotLamports)}
            </dd>
          </div>
          <div>
            <dt className="text-fog">Does not pot</dt>
            <dd className="mt-1 font-semibold text-chalk">
              {formatLamportsAsSol(receipt.doubtPotLamports)}
            </dd>
          </div>
          <div>
            <dt className="text-fog">Matched</dt>
            <dd className="mt-1 font-semibold text-chalk">
              {formatLamportsAsSol(receipt.matchedAmountLamports)}
            </dd>
          </div>
          <div>
            <dt className="text-fog">Refunded</dt>
            <dd className="mt-1 font-semibold text-chalk">
              {formatLamportsAsSol(receipt.refundedAmountLamports)}
            </dd>
          </div>
          <div>
            <dt className="text-fog">Paid</dt>
            <dd className="mt-1 font-semibold text-chalk">
              {formatLamportsAsSol(receipt.paidAmountLamports)}
            </dd>
          </div>
          <div>
            <dt className="text-fog">Positions</dt>
            <dd className="mt-1 font-semibold text-chalk">{receipt.positionCount}</dd>
          </div>
        </dl>
      </Card>

      {/* Trust badge (live via Realtime + in-browser proof re-check) */}
      <Card>
        <SectionTitle>The trust badge</SectionTitle>
        <div className="mt-3">
          <TrustBadge
            marketId={receipt.marketId}
            specTier={spec?.trustTier ?? null}
            initial={trustSnapshot}
          />
        </div>
      </Card>

      {/* Status timeline */}
      <Card>
        <SectionTitle>How it played out</SectionTitle>
        <div className="mt-4">
          <TimelineList
            steps={buildTimeline({
              status: receipt.status,
              createdAt: receipt.createdAt,
              settledAt: receipt.settledAt,
              outcome: receipt.outcome,
            })}
          />
        </div>
      </Card>

      {/* Evidence */}
      <Card>
        <SectionTitle>The evidence</SectionTitle>
        <p className="mt-1 text-[11px] text-fog/80">
          Derived facts from the verified feed — event, minute, sequence, confirmation.
        </p>
        <div className="mt-3">
          <EvidenceList facts={evidence} decidingSeq={receipt.decidingSeq} />
        </div>
      </Card>

      <div className="text-center">
        <Link
          href={`/g/${receipt.groupSlug}`}
          className="display-type inline-block rounded-xl border border-line bg-night-800 px-5 py-2.5 text-sm text-chalk transition-colors hover:border-pitch-500/50"
        >
          See this group’s record →
        </Link>
      </div>
    </PageShell>
  );
}
