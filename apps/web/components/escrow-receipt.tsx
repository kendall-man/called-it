import React from 'react';
import { ExternalLink, ShieldCheck } from 'lucide-react';
import { formatAtomicAmount, formatUtc } from '../lib/format';
import {
  escrowNetworkLabel,
  explorerTransactionUrlForCluster,
  type PublicEscrowReceipt,
} from '../lib/escrow-receipts';
import { Badge } from './ui';

const OUTCOME_LABEL = {
  claim_won: 'It happens won',
  claim_lost: 'It does not won',
  void: 'Voided - claims return eligible funds',
} as const;

export function EscrowReceiptDetails({ escrow }: { readonly escrow: PublicEscrowReceipt }) {
  return (
    <div className="mt-3 space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="pitch">Finalized escrow record</Badge>
        <Badge tone={escrow.cluster === 'mainnet-beta' ? 'flood' : 'sky'}>
          {escrowNetworkLabel(escrow.cluster)}
        </Badge>
        <Badge tone="neutral">{escrow.asset.toUpperCase()}</Badge>
      </div>

      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        <PublicValue label="Market PDA" value={escrow.marketPda} />
        <PublicValue label="Per-market vault" value={escrow.vaultPda} />
        <PublicValue label="Escrow program" value={escrow.programId} />
        <PublicValue label="Immutable document hash" value={escrow.documentHashHex} />
      </dl>

      <div>
        <p className="text-sm font-semibold text-chalk">Finalized transactions</p>
        <div className="mt-2 divide-y divide-line border-y border-line">
          <TransactionRow
            label="Market initialized"
            signature={escrow.initializeSignature}
            slot={escrow.initializeSlot}
            cluster={escrow.cluster}
          />
          {escrow.settlementSignature === null || escrow.settlementSlot === null ? (
            <p className="py-3 text-sm leading-6 text-fog">
              Settlement is not finalized yet. No final outcome is shown.
            </p>
          ) : (
            <TransactionRow
              label={escrow.outcome === null ? 'Market settled' : OUTCOME_LABEL[escrow.outcome]}
              signature={escrow.settlementSignature}
              slot={escrow.settlementSlot}
              cluster={escrow.cluster}
              timestamp={escrow.settledAt}
            />
          )}
          {escrow.claimTransactions.map((claim) => (
            <TransactionRow
              key={`${claim.signature}:${claim.claimKind}:${claim.slot}`}
              label={`${claim.claimKind === 'payout' ? 'Payout' : 'Refund'} · ${formatAtomicAmount(claim.amountAtomic, escrow.asset)} · ${claim.recipientCount} ${claim.recipientCount === 1 ? 'claim' : 'claims'}`}
              signature={claim.signature}
              slot={claim.slot}
              cluster={escrow.cluster}
              timestamp={claim.claimedAt}
            />
          ))}
        </div>
      </div>

      <div>
        <p className="text-sm font-semibold text-chalk">Finalized position aggregates</p>
        {escrow.aggregates.length === 0 ? (
          <p className="mt-2 text-sm leading-6 text-fog">No finalized position lots are indexed yet.</p>
        ) : (
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-3 border-y border-line py-4 sm:grid-cols-3">
            {escrow.aggregates.map((aggregate) => (
              <div key={`${aggregate.side}:${aggregate.state}`} className="min-w-0">
                <dt className="break-words text-xs text-fog">
                  {aggregate.side === 'back' ? 'It happens' : 'It does not'} · {stateLabel(aggregate.state)}
                </dt>
                <dd className="mt-1 break-words text-sm font-semibold text-chalk">
                  {formatAtomicAmount(aggregate.amountAtomic, escrow.asset)}
                </dd>
                <dd className="mt-0.5 text-xs text-fog">
                  {aggregate.lotCount} {aggregate.lotCount === 1 ? 'lot' : 'lots'}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-4 border-t border-line pt-4 text-sm">
        <div>
          <dt className="text-fog">Finalized payouts</dt>
          <dd className="mt-1 font-semibold text-chalk">
            {formatAtomicAmount(escrow.payoutTotalAtomic, escrow.asset)}
          </dd>
        </div>
        <div>
          <dt className="text-fog">Finalized refunds</dt>
          <dd className="mt-1 font-semibold text-chalk">
            {formatAtomicAmount(escrow.refundTotalAtomic, escrow.asset)}
          </dd>
        </div>
      </dl>
      <p className="flex items-start gap-2 text-xs leading-5 text-fog">
        <ShieldCheck className="mt-0.5 shrink-0 text-pitch-300" size={15} />
        Aggregate chain data only. Participant identities and wallet mappings are not published here.
      </p>
    </div>
  );
}

export function EscrowBoardSummary({ escrow }: { readonly escrow: PublicEscrowReceipt }) {
  const back = sumSide(escrow, 'back');
  const doubt = sumSide(escrow, 'doubt');
  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold text-pitch-300">Finalized on-chain escrow</span>
        <span className="text-fog">{escrowNetworkLabel(escrow.cluster)} · {escrow.asset.toUpperCase()}</span>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-xs sm:grid-cols-4">
        <BoardValue label="Happens total" value={formatAtomicAmount(back, escrow.asset)} />
        <BoardValue label="Does not total" value={formatAtomicAmount(doubt, escrow.asset)} />
        <BoardValue label="Payouts" value={formatAtomicAmount(escrow.payoutTotalAtomic, escrow.asset)} />
        <BoardValue label="Refunds" value={formatAtomicAmount(escrow.refundTotalAtomic, escrow.asset)} />
      </dl>
    </div>
  );
}

function TransactionRow(props: {
  readonly label: string;
  readonly signature: string;
  readonly slot: string;
  readonly cluster: PublicEscrowReceipt['cluster'];
  readonly timestamp?: string | null;
}) {
  const explorer = explorerTransactionUrlForCluster(props.signature, props.cluster);
  return (
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <p className="break-words text-sm font-semibold text-chalk">{props.label}</p>
        <p className="mt-1 text-xs text-fog">
          Finalized at slot {props.slot}{props.timestamp ? ` · ${formatUtc(props.timestamp)}` : ''}
        </p>
      </div>
      {explorer === null ? (
        <span className="break-all font-mono text-xs text-fog">{props.signature}</span>
      ) : (
        <a
          href={explorer}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-11 shrink-0 items-center gap-1 text-sm font-semibold text-sky-400 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pitch-300"
        >
          Explorer <ExternalLink size={15} />
        </a>
      )}
    </div>
  );
}

function PublicValue({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-fog">{label}</dt>
      <dd className="mt-1 break-all font-mono text-xs leading-5 text-chalk">{value}</dd>
    </div>
  );
}

function BoardValue({ label, value }: { readonly label: string; readonly value: string }) {
  return <div><dt className="text-fog">{label}</dt><dd className="mt-0.5 font-semibold text-chalk">{value}</dd></div>;
}

function sumSide(escrow: PublicEscrowReceipt, side: 'back' | 'doubt'): string {
  return escrow.aggregates
    .filter((row) => row.side === side)
    .reduce((sum, row) => sum + BigInt(row.amountAtomic), 0n)
    .toString();
}

function stateLabel(state: PublicEscrowReceipt['aggregates'][number]['state']): string {
  switch (state) {
    case 'pending': return 'pending';
    case 'active': return 'active';
    case 'invalidated': return 'invalidated';
    case 'refundable': return 'refundable';
    case 'claimed': return 'claimed';
  }
}
