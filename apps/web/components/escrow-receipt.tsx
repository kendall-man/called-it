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
  claim_won: 'Yes won',
  claim_lost: 'No won',
  void: 'Call cancelled · funds returned',
} as const;

export function EscrowReceiptDetails({ escrow }: { readonly escrow: PublicEscrowReceipt }) {
  return (
    <div className="mt-3 space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="pitch">Paid on Solana</Badge>
        <Badge tone={escrow.cluster === 'mainnet-beta' ? 'flood' : 'sky'}>
          {escrowNetworkLabel(escrow.cluster)}
        </Badge>
        <Badge tone="neutral">{escrow.asset.toUpperCase()}</Badge>
        {escrow.isReplay ? <Badge tone="flood">Past match · No points</Badge> : null}
      </div>

      <dl className="grid grid-cols-2 gap-4 border-y border-line py-4 text-sm">
        <div>
          <dt className="text-fog">Paid to winners</dt>
          <dd className="mt-1 font-mono font-medium tabular-nums text-chalk">
            {formatAtomicAmount(escrow.payoutTotalAtomic, escrow.asset)}
          </dd>
        </div>
        <div>
          <dt className="text-fog">Returned</dt>
          <dd className="mt-1 font-mono font-medium tabular-nums text-chalk">
            {formatAtomicAmount(escrow.refundTotalAtomic, escrow.asset)}
          </dd>
        </div>
      </dl>

      <div>
        <p className="text-sm font-semibold text-chalk">Payment records</p>
        <div className="mt-2 divide-y divide-line border-y border-line">
          <TransactionRow
            label="Call opened"
            signature={escrow.initializeSignature}
            slot={escrow.initializeSlot}
            cluster={escrow.cluster}
            instructionIndex={escrow.initializeInstructionIndex}
            timestamp={escrow.initializeBlockTime}
          />
          {escrow.settlementSignature === null || escrow.settlementSlot === null ? (
            <p className="py-3 text-sm leading-6 text-fog">
              Rumble is still waiting for the final result.
            </p>
          ) : (
            <TransactionRow
              label={escrow.outcome === null ? 'Result confirmed' : OUTCOME_LABEL[escrow.outcome]}
              signature={escrow.settlementSignature}
              slot={escrow.settlementSlot}
              cluster={escrow.cluster}
              instructionIndex={escrow.settlementInstructionIndex ?? undefined}
              timestamp={escrow.settledAt}
            />
          )}
          {escrow.claimTransactions.map((claim) => (
            <TransactionRow
              key={`${claim.signature}:${claim.claimKind}:${claim.slot}`}
              label={`${claim.claimKind === 'payout' ? 'Paid' : 'Returned'} · ${formatAtomicAmount(claim.amountAtomic, escrow.asset)} · ${claim.recipientCount} ${claim.recipientCount === 1 ? 'person' : 'people'}`}
              signature={claim.signature}
              slot={claim.slot}
              cluster={escrow.cluster}
              timestamp={claim.claimedAt}
            />
          ))}
        </div>
      </div>

      <div>
        <p className="text-sm font-semibold text-chalk">Group picks on Solana</p>
        {escrow.aggregates.length === 0 ? (
          <p className="mt-2 text-sm leading-6 text-fog">No picks are recorded on Solana yet.</p>
        ) : (
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-3 border-y border-line py-4 sm:grid-cols-3">
            {escrow.aggregates.map((aggregate) => (
              <div key={`${aggregate.side}:${aggregate.state}`} className="min-w-0">
                <dt className="break-words text-xs text-fog">
                  {aggregate.side === 'back' ? 'Yes' : 'No'} · {stateLabel(
                    aggregate.state,
                    escrow.outcome,
                  )}
                </dt>
                <dd className="mt-1 break-words text-sm font-semibold text-chalk">
                  {formatAtomicAmount(aggregate.amountAtomic, escrow.asset)}
                </dd>
                <dd className="mt-0.5 text-xs text-fog">
                  {aggregate.lotCount} {aggregate.lotCount === 1 ? 'pick' : 'picks'}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      <p className="flex items-start gap-2 text-xs leading-5 text-fog">
        <ShieldCheck className="mt-0.5 shrink-0 text-pitch-300" size={15} />
        This receipt shows group totals. Names, wallets and individual picks stay private.
      </p>

      <details className="border-t border-line pt-3 text-sm text-fog">
        <summary className="min-h-11 cursor-pointer content-center font-mono text-xs uppercase tracking-[0.08em] text-chalk focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pitch-300">
          Technical details
        </summary>
        <dl className="mt-3 grid gap-4 text-sm sm:grid-cols-2">
          <PublicValue label="Call account" value={escrow.marketPda} />
          <PublicValue label="Payment vault" value={escrow.vaultPda} />
          <PublicValue label="Solana program" value={escrow.programId} />
          <PublicValue label="Network ID" value={escrow.genesisHash} />
          {escrow.mintPubkey ? <PublicValue label="USDC mint" value={escrow.mintPubkey} /> : null}
          <PublicValue label="Payment version" value={String(escrow.custodyVersion)} />
          <PublicValue label="Receipt hash" value={escrow.documentHashHex} />
        </dl>
      </details>
    </div>
  );
}

export function EscrowBoardSummary({ escrow }: { readonly escrow: PublicEscrowReceipt }) {
  const back = sumSide(escrow, 'back');
  const doubt = sumSide(escrow, 'doubt');
  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold text-pitch-300">Paid on Solana</span>
        <span className="text-fog">{escrowNetworkLabel(escrow.cluster)} · {escrow.asset.toUpperCase()}</span>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-xs sm:grid-cols-4">
        <BoardValue label="Yes" value={formatAtomicAmount(back, escrow.asset)} />
        <BoardValue label="No" value={formatAtomicAmount(doubt, escrow.asset)} />
        <BoardValue label="Paid" value={formatAtomicAmount(escrow.payoutTotalAtomic, escrow.asset)} />
        <BoardValue label="Returned" value={formatAtomicAmount(escrow.refundTotalAtomic, escrow.asset)} />
      </dl>
    </div>
  );
}

function TransactionRow(props: {
  readonly label: string;
  readonly signature: string;
  readonly slot: string;
  readonly cluster: PublicEscrowReceipt['cluster'];
  readonly instructionIndex?: number;
  readonly timestamp?: string | null;
}) {
  const explorer = explorerTransactionUrlForCluster(props.signature, props.cluster);
  return (
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <p className="break-words text-sm font-semibold text-chalk">{props.label}</p>
        <p className="mt-1 text-xs text-fog">
          Confirmed on Solana{props.timestamp ? ` · ${formatUtc(props.timestamp)}` : ''}
        </p>
      </div>
      {explorer === null ? (
        <span className="break-all font-mono text-xs text-fog">{props.signature}</span>
      ) : (
        <a
          href={explorer}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-11 shrink-0 items-center gap-1 text-sm font-semibold text-pitch-300 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pitch-300"
        >
          View on Solana <ExternalLink aria-hidden size={15} />
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

function stateLabel(
  state: PublicEscrowReceipt['aggregates'][number]['state'],
  outcome: PublicEscrowReceipt['outcome'],
): string {
  // A void makes every finalized lot returnable even if its immutable
  // activation snapshot remained pending at the instant the market closed.
  // Receipts should lead with the terminal result, not the obsolete pre-close
  // activation state.
  if (outcome === 'void') return 'returned';
  switch (state) {
    case 'pending': return 'waiting';
    case 'active': return 'matched';
    case 'invalidated': return 'cancelled';
    case 'refundable': return 'ready to return';
    case 'claimed': return 'paid';
  }
}
