import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { EvidenceList, type EvidenceState } from '@/components/evidence-list';
import { AwaitingConfiguration, DataUnavailable } from '@/components/states';
import { TimelineList } from '@/components/timeline-list';
import { TrustBadge, type TrustSnapshot } from '@/components/trust-badge';
import { Badge, Card, PageShell, SectionTitle } from '@/components/ui';
import { formatAtomicAmount, formatMultiplier, formatProbabilityPct } from '@/lib/format';
import { fetchEvidence, fetchReceipt } from '@/lib/queries';
import type { EvidenceFact, PublicReceipt } from '@/lib/receipts';
import { PROVENANCE_COPY } from '@/lib/spec-terms';
import { createAnonServerClient } from '@/lib/supabase';
import { buildTimeline } from '@/lib/timeline';
import { isMainnet } from '@/lib/solana-network';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Receipt' };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OUTCOME_BANNER: Record<
  NonNullable<PublicReceipt['outcome']>,
  { readonly className: string; readonly label: string }
> = {
  claim_won: { className: 'bg-pitch-500 text-night-950', label: 'Called it' },
  claim_lost: { className: 'bg-siren-500 text-night-950', label: 'Did not land' },
  void: { className: 'bg-night-700 text-chalk', label: 'Void - recorded amounts returned' },
};

function AggregateGrid({ receipt }: { receipt: PublicReceipt }) {
  return (
    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
      <div>
        <dt className="text-fog">Happens pot</dt>
        <dd className="mt-1 font-semibold text-chalk">
          {formatAtomicAmount(receipt.backPotLamports, receipt.currency)}
        </dd>
      </div>
      <div>
        <dt className="text-fog">Does not pot</dt>
        <dd className="mt-1 font-semibold text-chalk">
          {formatAtomicAmount(receipt.doubtPotLamports, receipt.currency)}
        </dd>
      </div>
      <div>
        <dt className="text-fog">Matched</dt>
        <dd className="mt-1 font-semibold text-chalk">
          {formatAtomicAmount(receipt.matchedAmountLamports, receipt.currency)}
        </dd>
      </div>
      <div>
        <dt className="text-fog">Refunded</dt>
        <dd className="mt-1 font-semibold text-chalk">
          {formatAtomicAmount(receipt.refundedAmountLamports, receipt.currency)}
        </dd>
      </div>
      <div>
        <dt className="text-fog">Payout total</dt>
        <dd className="mt-1 font-semibold text-chalk">
          {formatAtomicAmount(receipt.paidAmountLamports, receipt.currency)}
        </dd>
      </div>
      <div>
        <dt className="text-fog">Positions</dt>
        <dd className="mt-1 font-semibold text-chalk">{receipt.positionCount}</dd>
      </div>
    </dl>
  );
}

export default async function ReceiptPage({
  params,
}: {
  params: Promise<{ marketId: string }>;
}) {
  const mainnet = isMainnet();
  const { marketId } = await params;
  if (!UUID_PATTERN.test(marketId)) notFound();

  const client = createAnonServerClient();
  if (!client) return <AwaitingConfiguration />;

  const receiptResult = await fetchReceipt(client, marketId);
  if (!receiptResult.ok) return <DataUnavailable retryHref={`/r/${marketId}`} />;
  const receipt = receiptResult.data;
  if (!receipt) notFound();

  const evidenceSeqs = [
    ...new Set(
      receipt.decidingSeq !== null
        ? [...receipt.evidenceSeqs, receipt.decidingSeq]
        : receipt.evidenceSeqs,
    ),
  ];
  let evidence: EvidenceFact[] = [];
  let evidenceState: EvidenceState = evidenceSeqs.length === 0 ? 'not_ready' : 'ready';
  if (evidenceSeqs.length > 0) {
    const evidenceResult = await fetchEvidence(client, receipt.terms.fixtureId, evidenceSeqs);
    if (evidenceResult.ok) {
      evidence = evidenceResult.data;
    } else {
      evidenceState = 'unavailable';
    }
  }

  const provenance = PROVENANCE_COPY[receipt.priceProvenance];
  const banner = receipt.outcome ? OUTCOME_BANNER[receipt.outcome] : null;
  const trustSnapshot: TrustSnapshot = {
    status: receipt.status,
    tier: receipt.tier,
    proofStatus: receipt.proofStatus,
    explorerUrl: receipt.explorerUrl,
    settledAt: receipt.settledAt,
    browserProof: receipt.browserProof,
  };

  return (
    <PageShell topRight={<Badge tone="neutral">Receipt</Badge>}>
      {banner ? (
        <div className={`display-type rounded-2xl px-5 py-3 text-center text-2xl ${banner.className}`}>
          {banner.label}
        </div>
      ) : null}

      <Card>
        <p className="display-type text-xs tracking-[0.25em] text-fog">On the record</p>
        <h1 className="mt-2 break-words text-3xl font-bold leading-tight text-chalk sm:text-4xl">
          {receipt.terms.text}
        </h1>
      </Card>

      <Card>
        <SectionTitle>Call terms</SectionTitle>
        <p className="mt-2 text-sm leading-relaxed text-fog">{receipt.terms.period}</p>
      </Card>

      <Card>
        <SectionTitle>Price at the call</SectionTitle>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="display-type text-5xl text-chalk">{formatMultiplier(receipt.quoteMultiplier)}</p>
            <p className="mt-1 text-sm text-fog">
              Recorded chance: {formatProbabilityPct(receipt.quoteProbability)}
            </p>
          </div>
          <Badge tone={receipt.priceProvenance === 'market' ? 'pitch' : 'flood'}>
            {provenance.label} price
          </Badge>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-fog">
          {provenance.blurb}{' '}
          {mainnet
            ? `Amounts below use ${receipt.currency.toUpperCase()} on Solana mainnet.`
            : `Amounts below use devnet ${receipt.currency.toUpperCase()} test tokens only.`}
        </p>
      </Card>

      <Card>
        <SectionTitle>Group totals</SectionTitle>
        <AggregateGrid receipt={receipt} />
      </Card>

      <Card>
        <SectionTitle>Proof status</SectionTitle>
        <div className="mt-3">
          <TrustBadge
            marketId={receipt.marketId}
            specTier={receipt.terms.trustTier}
            initial={trustSnapshot}
          />
        </div>
      </Card>

      <Card>
        <SectionTitle>Call timeline</SectionTitle>
        <div className="mt-4">
          <TimelineList
            steps={buildTimeline({
              status: receipt.status,
              createdAt: receipt.createdAt,
              settledAt: receipt.settledAt,
              outcome: receipt.outcome,
              currency: receipt.currency,
            })}
          />
        </div>
      </Card>

      <Card>
        <SectionTitle>Public evidence</SectionTitle>
        <div className="mt-3">
          <EvidenceList facts={evidence} decidingSeq={receipt.decidingSeq} state={evidenceState} />
        </div>
        {evidenceState === 'unavailable' ? (
          <Link
            href={`/r/${receipt.marketId}`}
            className="mt-4 inline-flex min-h-11 items-center text-sm font-semibold text-sky-400 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pitch-300"
          >
            Retry public evidence
          </Link>
        ) : null}
      </Card>

      <div className="text-center">
        <Link
          href={`/g/${receipt.groupSlug}`}
          className="display-type inline-flex min-h-11 items-center rounded-xl border border-line bg-night-800 px-5 text-sm text-chalk transition-colors hover:border-pitch-500/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pitch-300"
        >
          Open group board
        </Link>
      </div>
    </PageShell>
  );
}
