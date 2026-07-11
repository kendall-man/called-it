/**
 * Renders the compiled MarketSpec (stored as jsonb on markets.spec) into the
 * plain-English terms shown on receipt pages.
 *
 * Domain types are imported type-only from @calledit/market-engine (the
 * canonical source); the runtime guards below exist because jsonb from the
 * database is untyped at the wire boundary.
 */
import type {
  ClaimAnchor,
  ClaimType,
  Comparator,
  EntityRef,
  MarketSpec,
  Period,
  TrustTier,
} from '@calledit/market-engine';
import type { ProofStatus, ReceiptStatus, ReceiptTier } from './receipts';

// ── Defensive jsonb → MarketSpec parsing ─────────────────────────────────

type TermsRenderer = (spec: MarketSpec) => string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const COMPARATORS: readonly Comparator[] = ['gte', 'lte', 'eq'];
const PERIODS: readonly Period[] = ['FT', 'FT_90'];
const TRUST_TIERS: readonly TrustTier[] = ['chain_proven', 'oracle_resolved'];
const CLAIM_TYPES: readonly ClaimType[] = [
  'match_winner',
  'totals_ou',
  'team_scores_n',
  'btts',
  'player_scores_n',
  'comeback',
];
const SAFE_COMPILED_NAME = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .'/-]{0,95}$/u;

function oneOf<T extends string>(value: unknown, values: readonly T[]): T | null {
  if (typeof value !== 'string') return null;
  return values.find((candidate) => candidate === value) ?? null;
}

function isSafeCompiledName(value: unknown): value is string {
  return typeof value === 'string' && SAFE_COMPILED_NAME.test(value);
}

function parseEntityRef(value: unknown): EntityRef | null {
  if (!isRecord(value) || !isSafeCompiledName(value.name)) return null;
  if (value.kind === 'team' && (value.participant === 1 || value.participant === 2)) {
    return { kind: 'team', participant: value.participant, name: value.name };
  }
  if (
    value.kind === 'player' &&
    typeof value.normativeId === 'number' &&
    Number.isSafeInteger(value.normativeId) &&
    value.normativeId > 0
  ) {
    const participant =
      value.participant === 1 || value.participant === 2 ? value.participant : null;
    return { kind: 'player', normativeId: value.normativeId, name: value.name, participant };
  }
  return null;
}

function parseAnchor(value: unknown): ClaimAnchor | undefined {
  if (!isRecord(value)) return undefined;
  const { seq, scoreP1, scoreP2 } = value;
  if (
    typeof seq !== 'number' ||
    !Number.isSafeInteger(seq) ||
    seq < 0 ||
    typeof scoreP1 !== 'number' ||
    !Number.isSafeInteger(scoreP1) ||
    scoreP1 < 0 ||
    typeof scoreP2 !== 'number' ||
    !Number.isSafeInteger(scoreP2) ||
    scoreP2 < 0
  ) {
    return undefined;
  }
  return { seq, scoreP1, scoreP2 };
}

/** Null when the jsonb doesn't look like a compiled MarketSpec — callers degrade politely. */
export function parseMarketSpec(value: unknown): MarketSpec | null {
  if (!isRecord(value)) return null;
  const claimType = oneOf(value.claimType, CLAIM_TYPES);
  if (!claimType) return null;
  const entityRef = parseEntityRef(value.entityRef);
  if (!entityRef) return null;
  if (
    typeof value.fixtureId !== 'number' ||
    !Number.isSafeInteger(value.fixtureId) ||
    value.fixtureId < 0 ||
    typeof value.threshold !== 'number' ||
    !Number.isFinite(value.threshold) ||
    value.threshold < 0
  ) {
    return null;
  }
  const comparator = oneOf(value.comparator, COMPARATORS);
  const period = oneOf(value.period, PERIODS);
  const trustTier = oneOf(value.trustTier, TRUST_TIERS);
  if (!comparator || !period || !trustTier) return null;
  return {
    claimType,
    fixtureId: value.fixtureId,
    entityRef,
    comparator,
    threshold: value.threshold,
    period,
    anchor: parseAnchor(value.anchor),
    trustTier,
  };
}

// ── Plain-English rendering (game-show register — no odds/bookie words) ──

function countPhrase(comparator: Comparator, threshold: number, noun: string): string {
  const unit = threshold === 1 ? noun : `${noun}s`;
  switch (comparator) {
    case 'gte':
      return `${threshold} ${unit} or more`;
    case 'lte':
      return `${threshold} ${unit} or fewer`;
    case 'eq':
      return `exactly ${threshold} ${unit}`;
  }
}

const TERMS_RENDERERS = {
  match_winner: (spec) => `${spec.entityRef.name} to win`,
  totals_ou: (spec) => `${countPhrase(spec.comparator, spec.threshold, 'goal')} in the match`,
  team_scores_n: (spec) =>
    `${spec.entityRef.name} to score ${countPhrase(spec.comparator, spec.threshold, 'goal')}`,
  btts: () => 'Both teams to score',
  player_scores_n: (spec) =>
    spec.comparator === 'gte' && spec.threshold === 1
      ? `${spec.entityRef.name} to score`
      : `${spec.entityRef.name} to score ${countPhrase(spec.comparator, spec.threshold, 'goal')}`,
  comeback: (spec) => {
    const from = spec.anchor ? ` from ${spec.anchor.scoreP1}–${spec.anchor.scoreP2} down` : '';
    return `${spec.entityRef.name} to turn it around${from} and win`;
  },
} satisfies Record<ClaimType, TermsRenderer>;

/** The call, on paper — one sentence. */
export function describeTerms(spec: MarketSpec): string {
  return TERMS_RENDERERS[spec.claimType](spec);
}

/** How the clock is counted, one line. */
export function describePeriod(period: Period): string {
  return period === 'FT_90'
    ? 'In 90 minutes — extra time and shootouts don’t count'
    : 'However it ends — extra time and shootouts count';
}

export interface TierCopy {
  label: string;
  blurb: string;
}

const TIER_COPY: Record<TrustTier, TierCopy> = {
  chain_proven: {
    label: 'Chain-proven',
    blurb:
      'Team stats are sealed into a Merkle root published on Solana — anyone can re-check this result, no account needed.',
  },
  oracle_resolved: {
    label: 'Oracle-resolved',
    blurb:
      'Settled from the cryptographically signed TxLINE data feed. Player-level facts aren’t chain-provable yet, so the badge says so honestly.',
  },
};

export function describeTier(tier: TrustTier): TierCopy {
  return TIER_COPY[tier];
}

export type PublicTrustTone = 'pitch' | 'flood' | 'siren' | 'sky' | 'neutral';

export interface PublicTrustPresentation {
  readonly tone: PublicTrustTone;
  readonly label: string;
  readonly detail: string | null;
}

export interface PublicTrustInput {
  readonly status: ReceiptStatus;
  readonly tier: ReceiptTier | null;
  readonly proofStatus: ProofStatus | null;
}

/**
 * Truthful public proof language. A settled result and a verified chain proof
 * are separate facts, so neither pending nor unavailable proof work becomes a
 * successful-proof badge.
 */
export function describeTrustState(
  input: PublicTrustInput,
  specTier: ReceiptTier | null,
): PublicTrustPresentation {
  const tier = input.tier ?? specTier;

  if (input.status === 'voided') {
    return {
      tone: 'neutral',
      label: 'Call voided',
      detail: 'There is no result to verify. Every recorded position was returned.',
    };
  }

  if (input.status !== 'settled') {
    return {
      tone: 'neutral',
      label: 'Not settled yet',
      detail: tier
        ? `This call is set to use ${describeTier(tier).label} after settlement.`
        : 'The proof source will be recorded after settlement.',
    };
  }

  if (tier === 'chain_proven') {
    switch (input.proofStatus) {
      case 'verified':
        return {
          tone: 'pitch',
          label: 'Chain proof verified',
          detail: 'The settled result is backed by a published Solana proof record.',
        };
      case 'pending':
      case null:
        return {
          tone: 'flood',
          label: 'Chain proof not yet verified',
          detail: 'The result is settled from the signed feed while the chain proof is still pending.',
        };
      case 'unavailable':
        return {
          tone: 'flood',
          label: 'Chain proof unavailable',
          detail: 'The result is settled from the signed feed. No chain proof is available for this receipt.',
        };
      case 'failed':
        return {
          tone: 'siren',
          label: 'Chain proof could not verify',
          detail: 'The result is settled from the signed feed, but this receipt has no verified chain proof.',
        };
    }
  }

  if (tier === 'oracle_resolved') {
    return {
      tone: 'sky',
      label: 'Signed feed resolved',
      detail: 'This result comes from the signed TxLINE feed. This call does not use a chain proof.',
    };
  }

  return {
    tone: 'neutral',
    label: 'Proof source unavailable',
    detail: 'The result is settled, but this receipt has no public proof source.',
  };
}

export const PROVENANCE_COPY: Record<'market' | 'modelled', { label: string; blurb: string }> = {
  market: {
    label: 'Market',
    blurb: 'Priced straight from live match data at the moment of the call.',
  },
  modelled: {
    label: 'Modelled',
    blurb: 'Priced by our model over the live match data — labelled so you know.',
  },
};
