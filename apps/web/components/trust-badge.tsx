'use client';

/**
 * The receipt's trust badge. Server-rendered with an initial snapshot, then:
 *  - subscribes to Supabase Realtime on settlements + proofs for this market
 *    and refetches the public_receipts view when either changes (live flip);
 *  - when a chain proof is verified, attempts an in-browser merkle re-check
 *    via @calledit/solana/verify (through the solana-verify-bridge alias)
 *    against the on-chain daily root, with a graceful
 *    "verification unavailable" fallback at every step.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  fetchOnchainRoots,
  verifyMerkleProof,
  type MerkleProofNode,
} from 'solana-verify-bridge';
import { getSolanaConfig } from '@/lib/env';
import { getAnonBrowserClient } from '@/lib/supabase';
import {
  pickBestReceiptRow,
  receiptFromRow,
  type ProofStatus,
  type PublicReceipt,
  type ReceiptStatus,
  type ReceiptTier,
} from '@/lib/receipts';
import { describeTier } from '@/lib/spec-terms';
import { Badge, type BadgeTone } from './ui';

const MS_PER_EPOCH_DAY = 86_400_000;
const RECEIPTS_VIEW = 'public_receipts';

export interface TrustSnapshot {
  status: ReceiptStatus;
  tier: ReceiptTier | null;
  proofStatus: ProofStatus | null;
  explorerUrl: string | null;
  settledAt: string | null;
  merkleProof: unknown;
}

/** The trust tier the compiler stamped on the spec — shown before settlement lands. */
export interface TrustBadgeProps {
  marketId: string;
  specTier: ReceiptTier | null;
  initial: TrustSnapshot;
}

type BrowserCheck =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'confirmed' }
  | { state: 'unavailable'; note: string };

function snapshotFromReceipt(receipt: PublicReceipt): TrustSnapshot {
  return {
    status: receipt.status,
    tier: receipt.tier,
    proofStatus: receipt.proofStatus,
    explorerUrl: receipt.explorerUrl,
    settledAt: receipt.settledAt,
    merkleProof: receipt.merkleProof,
  };
}

/**
 * Tolerantly pull `{leaf, proof: MerkleProofNode[]}` out of whatever shape the
 * proofs row stores (the OpenAPI stat-validation payload or a near relative).
 */
function extractProofMaterial(
  value: unknown,
): { leaf: string; proof: MerkleProofNode[] } | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const leaf = typeof record.leaf === 'string' ? record.leaf : null;
  const rawPath = record.proof ?? record.path ?? record.siblings;
  if (!leaf || !Array.isArray(rawPath)) return null;
  const proof: MerkleProofNode[] = [];
  for (const node of rawPath) {
    if (typeof node !== 'object' || node === null) return null;
    const step = node as Record<string, unknown>;
    const hash = typeof step.hash === 'string' ? step.hash : null;
    const side = step.isRightSibling ?? step.isRight ?? step.right;
    if (!hash || typeof side !== 'boolean') return null;
    proof.push({ hash, isRightSibling: side });
  }
  return { leaf, proof };
}

interface BadgeView {
  tone: BadgeTone;
  label: string;
  sub: string | null;
}

function deriveView(snapshot: TrustSnapshot, specTier: ReceiptTier | null): BadgeView {
  const settled = snapshot.status === 'settled';
  const tier = snapshot.tier ?? specTier;

  if (snapshot.status === 'voided') {
    return { tone: 'neutral', label: 'No verdict — call voided', sub: 'Every stake returned.' };
  }
  if (!settled) {
    if (!tier) return { tone: 'neutral', label: 'Awaiting the final whistle', sub: null };
    return {
      tone: 'neutral',
      label: `Settles ${describeTier(tier).label}`,
      sub: 'Verdict lands seconds after the deciding stat confirms.',
    };
  }
  if (tier === 'chain_proven') {
    if (snapshot.proofStatus === 'verified') {
      return { tone: 'pitch', label: 'Chain-proven ✓', sub: null };
    }
    if (snapshot.proofStatus === 'failed' || snapshot.proofStatus === 'unavailable') {
      return {
        tone: 'sky',
        label: 'Oracle-resolved ✓',
        sub: 'The on-chain seal didn’t land for this one — the result stands from the signed feed.',
      };
    }
    return {
      tone: 'flood',
      label: 'Proof on the way',
      sub: 'Settled from the signed feed; the on-chain seal lands after the daily batch closes.',
    };
  }
  return { tone: 'sky', label: 'Oracle-resolved ✓', sub: null };
}

export function TrustBadge({ marketId, specTier, initial }: TrustBadgeProps) {
  const [snapshot, setSnapshot] = useState<TrustSnapshot>(initial);
  const [check, setCheck] = useState<BrowserCheck>({ state: 'idle' });

  const refetch = useCallback(async () => {
    const client = getAnonBrowserClient();
    if (!client) return;
    const { data, error } = await client
      .from(RECEIPTS_VIEW)
      .select('*')
      .eq('market_id', marketId);
    if (error || !Array.isArray(data)) return;
    const receipts = data
      .map((row) => receiptFromRow(row as Record<string, unknown>))
      .filter((receipt): receipt is PublicReceipt => receipt !== null);
    const best = pickBestReceiptRow(receipts);
    if (best) setSnapshot(snapshotFromReceipt(best));
  }, [marketId]);

  // Live flip: any settlement/proof change for this market refreshes the view.
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

  // In-browser re-verification, attempted once the proof is marked verified.
  useEffect(() => {
    const verifiedChainProof =
      snapshot.tier === 'chain_proven' && snapshot.proofStatus === 'verified';
    if (!verifiedChainProof) return;

    let cancelled = false;
    const unavailable = (note: string) => {
      if (!cancelled) setCheck({ state: 'unavailable', note });
    };

    setCheck({ state: 'checking' });
    void (async () => {
      const solana = getSolanaConfig();
      if (!solana) {
        return unavailable('no public RPC configured for this deploy');
      }
      if (!snapshot.settledAt) {
        return unavailable('settlement day unknown');
      }
      const settledMs = Date.parse(snapshot.settledAt);
      if (Number.isNaN(settledMs)) {
        return unavailable('settlement day unknown');
      }
      const epochDay = Math.floor(settledMs / MS_PER_EPOCH_DAY);
      try {
        const material = extractProofMaterial(snapshot.merkleProof);
        if (!material) {
          return unavailable('proof bytes aren’t published on this page — see the explorer');
        }
        // TxLINE publishes one root per batch, so a day holds many: fetch the
        // day's roots and check the proof lands on any of them.
        const roots = await fetchOnchainRoots(solana.rpcUrl, solana.programId, epochDay);
        if (!roots || roots.length === 0) {
          return unavailable('couldn’t read the daily roots from the chain in this browser');
        }
        const matches = roots.some((entry) =>
          verifyMerkleProof({ leaf: material.leaf, proof: material.proof, root: entry.rootHex }),
        );
        if (!matches) {
          return unavailable('this browser’s re-check didn’t line up — see the explorer');
        }
        if (!cancelled) setCheck({ state: 'confirmed' });
      } catch {
        unavailable('verification unavailable in this browser — see the explorer');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [snapshot.tier, snapshot.proofStatus, snapshot.settledAt, snapshot.merkleProof]);

  const view = deriveView(snapshot, specTier);
  const tierForBlurb = snapshot.tier ?? specTier;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={view.tone} className="px-3 py-1 text-sm normal-case tracking-normal">
          {view.label}
        </Badge>
        {snapshot.explorerUrl ? (
          <a
            href={snapshot.explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-semibold text-pitch-300 underline decoration-pitch-500/50 underline-offset-4 hover:text-pitch-400"
          >
            View on explorer ↗
          </a>
        ) : null}
      </div>

      {view.sub ? <p className="text-xs leading-relaxed text-fog">{view.sub}</p> : null}

      {snapshot.tier === 'chain_proven' && snapshot.proofStatus === 'verified' ? (
        <p className="text-xs text-fog" aria-live="polite">
          {check.state === 'checking' && 'Re-checking the proof in your browser…'}
          {check.state === 'confirmed' && (
            <span className="text-pitch-300">Re-checked in your browser against the on-chain root ✓</span>
          )}
          {check.state === 'unavailable' && `Browser re-check unavailable: ${check.note}.`}
          {check.state === 'idle' && null}
        </p>
      ) : null}

      {tierForBlurb ? (
        <details className="group text-xs text-fog">
          <summary className="cursor-pointer list-none font-semibold text-fog/90 underline decoration-line underline-offset-4 hover:text-chalk">
            What does “{describeTier(tierForBlurb).label}” mean?
          </summary>
          <p className="mt-1.5 leading-relaxed">{describeTier(tierForBlurb).blurb}</p>
        </details>
      ) : null}
    </div>
  );
}
