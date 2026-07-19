'use client';

/**
 * Live public proof state. The component reads only the explicitly projected
 * receipt view and never renders transactions, wallet identifiers, or raw
 * proof payloads.
 */
import { useCallback, useEffect, useState } from 'react';
import { fetchOnchainRoots, verifyMerkleProof } from 'solana-verify-bridge';
import { getSolanaConfig } from '@/lib/env';
import { PUBLIC_RECEIPT_SELECT } from '@/lib/queries';
import {
  pickBestReceiptRow,
  receiptFromRow,
  type ProofStatus,
  type PublicBrowserProof,
  type PublicReceipt,
  type ReceiptStatus,
  type ReceiptTier,
} from '@/lib/receipts';
import { describeTier, describeTrustState } from '@/lib/spec-terms';
import { getAnonBrowserClient } from '@/lib/supabase';
import { Badge } from './ui';

const MS_PER_EPOCH_DAY = 86_400_000;
const RECEIPTS_VIEW = 'public_receipts';

export interface TrustSnapshot {
  readonly status: ReceiptStatus;
  readonly tier: ReceiptTier | null;
  readonly proofStatus: ProofStatus | null;
  readonly explorerUrl: string | null;
  readonly settledAt: string | null;
  readonly browserProof: PublicBrowserProof | null;
}

export interface TrustBadgeProps {
  readonly marketId: string;
  readonly specTier: ReceiptTier | null;
  readonly initial: TrustSnapshot;
}

type BrowserCheck =
  | { readonly state: 'idle' }
  | { readonly state: 'checking' }
  | { readonly state: 'confirmed' }
  | { readonly state: 'unavailable'; readonly note: string };

function snapshotFromReceipt(receipt: PublicReceipt): TrustSnapshot {
  return {
    status: receipt.status,
    tier: receipt.tier,
    proofStatus: receipt.proofStatus,
    explorerUrl: receipt.explorerUrl,
    settledAt: receipt.settledAt,
    browserProof: receipt.browserProof,
  };
}

function hasSnapshotChanged(current: TrustSnapshot, next: TrustSnapshot): boolean {
  return (
    current.status !== next.status ||
    current.tier !== next.tier ||
    current.proofStatus !== next.proofStatus ||
    current.explorerUrl !== next.explorerUrl ||
    current.settledAt !== next.settledAt ||
    current.browserProof?.leaf !== next.browserProof?.leaf
  );
}

function safeExternalUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function TrustBadge({ marketId, specTier, initial }: TrustBadgeProps) {
  const [snapshot, setSnapshot] = useState<TrustSnapshot>(initial);
  const [check, setCheck] = useState<BrowserCheck>({ state: 'idle' });
  const [updateNotice, setUpdateNotice] = useState('');

  const refetch = useCallback(async () => {
    const client = getAnonBrowserClient();
    if (!client) return;
    const { data, error } = await client
      .from(RECEIPTS_VIEW)
      .select(PUBLIC_RECEIPT_SELECT)
      .eq('market_id', marketId)
      .limit(2);
    if (error || !Array.isArray(data)) return;

    const receipts = data
      .map(receiptFromRow)
      .filter((receipt): receipt is PublicReceipt => receipt !== null);
    const next = pickBestReceiptRow(receipts);
    if (!next) return;
    const nextSnapshot = snapshotFromReceipt(next);
    setSnapshot((current) => {
      if (!hasSnapshotChanged(current, nextSnapshot)) return current;
      setUpdateNotice('Receipt updated with the latest result check.');
      return nextSnapshot;
    });
  }, [marketId]);

  useEffect(() => {
    const client = getAnonBrowserClient();
    if (!client) return;
    const channel = client
      .channel(`receipt-${marketId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'settlements', filter: `market_id=eq.${marketId}` },
        () => void refetch(),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'proofs', filter: `market_id=eq.${marketId}` },
        () => void refetch(),
      )
      .subscribe();
    return () => {
      void client.removeChannel(channel);
    };
  }, [marketId, refetch]);

  useEffect(() => {
    const proof = snapshot.browserProof;
    const isVerifiedChainProof =
      snapshot.tier === 'chain_proven' && snapshot.proofStatus === 'verified' && proof !== null;
    if (!isVerifiedChainProof) {
      setCheck({ state: 'idle' });
      return;
    }

    let cancelled = false;
    const unavailable = (note: string) => {
      if (!cancelled) setCheck({ state: 'unavailable', note });
    };

    setCheck({ state: 'checking' });
    void (async () => {
      const solana = getSolanaConfig();
      if (!solana) return unavailable('a public RPC is not configured for this page');
      if (!snapshot.settledAt) return unavailable('the settlement time is missing');
      const settledMs = Date.parse(snapshot.settledAt);
      if (Number.isNaN(settledMs)) return unavailable('the settlement time is invalid');

      try {
        const roots = await fetchOnchainRoots(
          solana.rpcUrl,
          solana.programId,
          Math.floor(settledMs / MS_PER_EPOCH_DAY),
        );
        if (!roots || roots.length === 0) return unavailable('daily chain roots could not be read');
        const matches = roots.some((root) =>
          verifyMerkleProof({ leaf: proof.leaf, proof: proof.proof, root: root.rootHex }),
        );
        if (!matches) return unavailable('this browser could not confirm the published root');
        if (!cancelled) setCheck({ state: 'confirmed' });
      } catch (error) {
        if (error instanceof Error) {
          unavailable('verification is unavailable in this browser');
          return;
        }
        unavailable('verification is unavailable in this browser');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [snapshot.browserProof, snapshot.proofStatus, snapshot.settledAt, snapshot.tier]);

  const view = describeTrustState(snapshot, specTier);
  const tierForDetail = snapshot.tier ?? specTier;
  const explorerUrl = safeExternalUrl(snapshot.explorerUrl);

  return (
    <div className="space-y-2">
      <p className="sr-only" aria-live="polite">
        {updateNotice}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={view.tone} className="px-3 py-1 text-sm normal-case tracking-normal">
          {view.label}
        </Badge>
        {explorerUrl ? (
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="min-h-11 content-center text-sm font-semibold text-pitch-300 underline decoration-pitch-500/50 underline-offset-4 hover:text-pitch-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pitch-300"
          >
            View on Solana
          </a>
        ) : null}
      </div>

      {view.detail ? <p className="text-sm leading-relaxed text-fog">{view.detail}</p> : null}

      {snapshot.tier === 'chain_proven' && snapshot.proofStatus === 'verified' ? (
        <p className="text-sm text-fog" aria-live="polite">
          {check.state === 'checking' && 'Checking the Solana record.'}
          {check.state === 'confirmed' && (
            <span className="text-pitch-300">Solana record confirmed.</span>
          )}
          {check.state === 'unavailable' && `Solana check unavailable: ${check.note}.`}
        </p>
      ) : null}

      {tierForDetail ? (
        <details className="text-sm text-fog">
          <summary className="min-h-11 cursor-pointer content-center font-semibold underline decoration-line underline-offset-4 hover:text-chalk focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pitch-300">
            How this was checked
          </summary>
          <p className="mt-1.5 leading-relaxed">{describeTier(tierForDetail).blurb}</p>
        </details>
      ) : null}
    </div>
  );
}
