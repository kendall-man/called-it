import Link from 'next/link';
import { formatLamportsAsSol, formatMultiplier, formatUtc } from '@/lib/format';
import type {
  PublicGroupBoardMarket,
  PublicReceipt,
  ReceiptOutcome,
  ReceiptStatus,
} from '@/lib/receipts';
import { Badge, type BadgeTone } from './ui';

const OUTCOME_CHIP: Record<ReceiptOutcome, { tone: BadgeTone; label: string }> = {
  claim_won: { tone: 'pitch', label: 'Called it' },
  claim_lost: { tone: 'siren', label: 'Didn’t land' },
  void: { tone: 'neutral', label: 'Void' },
};

type PublicMarketStatus = {
  readonly status: ReceiptStatus;
  readonly outcome: ReceiptOutcome | null;
};

function statusChip(market: PublicMarketStatus): { tone: BadgeTone; label: string } {
  if (market.outcome) return OUTCOME_CHIP[market.outcome];
  switch (market.status) {
    case 'voided':
      return { tone: 'neutral', label: 'Void' };
    case 'settled':
      return { tone: 'sky', label: 'Settled' };
    case 'frozen':
      return { tone: 'flood', label: 'Calls locked' };
    case 'settling':
      return { tone: 'flood', label: 'Settling' };
    case 'pending_lineup':
      return { tone: 'neutral', label: 'Waiting on lineups' };
    case 'open':
      return { tone: 'sky', label: 'Calls open' };
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
        <dt className="text-fog">Happens pot</dt>
        <dd className="mt-0.5 font-semibold text-chalk">
          {formatLamportsAsSol(market.backPotLamports)}
        </dd>
      </div>
      <div>
        <dt className="text-fog">Does not pot</dt>
        <dd className="mt-0.5 font-semibold text-chalk">
          {formatLamportsAsSol(market.doubtPotLamports)}
        </dd>
      </div>
      <div>
        <dt className="text-fog">Matched</dt>
        <dd className="mt-0.5 font-semibold text-chalk">
          {formatLamportsAsSol(market.matchedAmountLamports)}
        </dd>
      </div>
      <div>
        <dt className="text-fog">Refunded</dt>
        <dd className="mt-0.5 font-semibold text-chalk">
          {formatLamportsAsSol(market.refundedAmountLamports)}
        </dd>
      </div>
      <div>
        <dt className="text-fog">Payout total</dt>
        <dd className="mt-0.5 font-semibold text-chalk">
          {formatLamportsAsSol(market.paidAmountLamports)}
        </dd>
      </div>
      <div>
        <dt className="text-fog">Positions</dt>
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
      className="group flex min-h-11 items-center gap-3 rounded-xl border border-transparent px-2 py-2.5 transition-colors hover:border-line hover:bg-night-800/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pitch-300"
    >
      <span className="display-type w-14 shrink-0 text-right text-xl text-chalk">
        {formatMultiplier(receipt.quoteMultiplier)}
      </span>
      <span className="min-w-0 flex-1">
          <span className="block break-words text-sm font-semibold text-chalk">
            {receipt.terms.text}
          </span>
          <span className="block text-[11px] text-fog">
            {formatUtc(receipt.createdAt)} - {receipt.positionCount} positions -{' '}
            {formatLamportsAsSol(receipt.matchedAmountLamports)} matched
          </span>
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
        </div>
        <Badge tone={chip.tone}>{chip.label}</Badge>
      </div>
      <p className="mt-2 text-xs text-fog">
        {formatMultiplier(market.quoteMultiplier)} multiplier - {timingLabel(market)}
      </p>
      <AggregateSummary market={market} />
    </article>
  );
}
