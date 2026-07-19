import Link from 'next/link';
import { formatAtomicAmount, formatMultiplier, formatUtc } from '@/lib/format';
import type {
  PublicGroupBoardMarket,
  PublicReceipt,
  ReceiptOutcome,
  ReceiptStatus,
} from '@/lib/receipts';
import { Badge, type BadgeTone } from './ui';
import { EscrowBoardSummary } from './escrow-receipt';

const OUTCOME_CHIP: Record<ReceiptOutcome, { tone: BadgeTone; label: string }> = {
  claim_won: { tone: 'pitch', label: 'Yes won' },
  claim_lost: { tone: 'siren', label: 'No won' },
  void: { tone: 'neutral', label: 'Cancelled' },
};

type PublicMarketStatus = {
  readonly status: ReceiptStatus;
  readonly outcome: ReceiptOutcome | null;
};

function statusChip(market: PublicMarketStatus): { tone: BadgeTone; label: string } {
  if (market.outcome) return OUTCOME_CHIP[market.outcome];
  switch (market.status) {
    case 'voided':
      return { tone: 'neutral', label: 'Cancelled' };
    case 'settled':
      return { tone: 'sky', label: 'Settled' };
    case 'frozen':
      return { tone: 'flood', label: 'Picks closed' };
    case 'settling':
      return { tone: 'flood', label: 'Checking result' };
    case 'pending_lineup':
      return { tone: 'neutral', label: 'Waiting for lineups' };
    case 'open':
      return { tone: 'sky', label: 'Open' };
  }
}

function timingLabel(market: PublicGroupBoardMarket): string {
  if (market.settledAt) return `Settled ${formatUtc(market.settledAt)}`;
  return `Opened ${formatUtc(market.createdAt)}`;
}

function AggregateSummary({ market }: { market: PublicGroupBoardMarket }) {
  return (
    <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs sm:grid-cols-3">
      <div>
        <dt className="text-fog">Yes</dt>
        <dd className="mt-0.5 font-semibold text-chalk">
          {formatAtomicAmount(market.backPotLamports, market.currency)}
        </dd>
      </div>
      <div>
        <dt className="text-fog">No</dt>
        <dd className="mt-0.5 font-semibold text-chalk">
          {formatAtomicAmount(market.doubtPotLamports, market.currency)}
        </dd>
      </div>
      <div>
        <dt className="text-fog">Matched</dt>
        <dd className="mt-0.5 font-semibold text-chalk">
          {formatAtomicAmount(market.matchedAmountLamports, market.currency)}
        </dd>
      </div>
      <div>
        <dt className="text-fog">Returned</dt>
        <dd className="mt-0.5 font-semibold text-chalk">
          {formatAtomicAmount(market.refundedAmountLamports, market.currency)}
        </dd>
      </div>
      <div>
        <dt className="text-fog">Paid to winners</dt>
        <dd className="mt-0.5 font-semibold text-chalk">
          {formatAtomicAmount(market.paidAmountLamports, market.currency)}
        </dd>
      </div>
      <div>
        <dt className="text-fog">Picks</dt>
        <dd className="mt-0.5 font-semibold text-chalk">{market.positionCount}</dd>
      </div>
    </dl>
  );
}

export function ReceiptRow({ receipt }: { receipt: PublicReceipt }) {
  const chip = statusChip(receipt);
  return (
    <Link
      href={`/r/${receipt.marketId}`}
      className="group flex min-h-11 items-center gap-3 border border-transparent px-2 py-2.5 transition-colors hover:border-line hover:bg-night-800/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pitch-300"
    >
      <span className="display-type w-14 shrink-0 text-right text-xl text-chalk">
        {formatMultiplier(receipt.quoteMultiplier)}
      </span>
      <span className="min-w-0 flex-1">
          <span className="block break-words text-sm font-semibold text-chalk">
            {receipt.terms.text}
          </span>
          {receipt.isReplay ? (
            <span className="mt-0.5 block text-[11px] font-semibold text-flood-300">
              Past match replay · No points
            </span>
          ) : null}
          <span className="block text-[11px] text-fog">
            {formatUtc(receipt.createdAt)} · {receipt.positionCount} picks ·{' '}
            {formatAtomicAmount(receipt.matchedAmountLamports, receipt.currency)} matched
          </span>
          {receipt.escrow ? (
            <span className="mt-1 block text-[11px] font-semibold text-pitch-300">
              Paid on Solana · {receipt.escrow.asset.toUpperCase()}
            </span>
          ) : null}
      </span>
      <Badge tone={chip.tone}>{chip.label}</Badge>
    </Link>
  );
}

/** Aggregate-only board row. It deliberately has no speaker or participant identity. */
export function BoardMarketRow({ market }: { market: PublicGroupBoardMarket }) {
  const chip = statusChip(market);
  return (
    <article className="border-b border-line/70 py-4 first:pt-2 last:border-b-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Link
            href={`/r/${market.marketId}`}
            className="block text-base font-semibold text-chalk underline decoration-line underline-offset-4 hover:text-pitch-300 hover:decoration-pitch-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pitch-300"
          >
            {market.terms.text}
          </Link>
          <p className="mt-1 text-xs text-fog">{market.terms.period}</p>
          {market.isReplay ? (
            <p className="mt-1 text-xs font-semibold text-flood-300">
              Past match replay · No points
            </p>
          ) : null}
        </div>
        <Badge tone={chip.tone}>{chip.label}</Badge>
      </div>
      <p className="mt-2 text-xs text-fog">
        {formatMultiplier(market.quoteMultiplier)} · {timingLabel(market)}
      </p>
      <AggregateSummary market={market} />
      {market.escrow ? <EscrowBoardSummary escrow={market.escrow} /> : null}
    </article>
  );
}
