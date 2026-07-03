import Link from 'next/link';
import { formatMultiplier, formatUtc } from '@/lib/format';
import type { PublicReceipt, ReceiptOutcome } from '@/lib/receipts';
import { Badge, type BadgeTone } from './ui';

const OUTCOME_CHIP: Record<ReceiptOutcome, { tone: BadgeTone; label: string }> = {
  claim_won: { tone: 'pitch', label: 'Called it' },
  claim_lost: { tone: 'siren', label: 'Didn’t land' },
  void: { tone: 'neutral', label: 'Void' },
};

function statusChip(receipt: PublicReceipt): { tone: BadgeTone; label: string } {
  if (receipt.outcome) return OUTCOME_CHIP[receipt.outcome];
  switch (receipt.status) {
    case 'voided':
      return { tone: 'neutral', label: 'Void' };
    case 'frozen':
      return { tone: 'flood', label: 'Calls locked' };
    case 'settling':
      return { tone: 'flood', label: 'Settling' };
    case 'pending_lineup':
      return { tone: 'neutral', label: 'Waiting on lineups' };
    default:
      return { tone: 'sky', label: 'In play' };
  }
}

export function ReceiptRow({ receipt }: { receipt: PublicReceipt }) {
  const chip = statusChip(receipt);
  return (
    <Link
      href={`/r/${receipt.marketId}`}
      className="group flex items-center gap-3 rounded-xl border border-transparent px-2 py-2.5 transition-colors hover:border-line hover:bg-night-800/60"
    >
      <span className="display-type w-14 shrink-0 text-right text-xl text-chalk">
        {formatMultiplier(receipt.quoteMultiplier)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-chalk">
          “{receipt.quotedText}”
        </span>
        <span className="block text-[11px] text-fog">
          {receipt.claimerName} · {formatUtc(receipt.createdAt)}
          {receipt.isReplay ? ' · replay' : ''}
        </span>
      </span>
      <Badge tone={chip.tone}>{chip.label}</Badge>
    </Link>
  );
}
