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

// ── Defensive jsonb → MarketSpec parsing ─────────────────────────────────

type TermsRenderer = (spec: MarketSpec) => string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const COMPARATORS: readonly Comparator[] = ['gte', 'lte', 'eq'];
const PERIODS: readonly Period[] = ['FT', 'FT_90'];
const TRUST_TIERS: readonly TrustTier[] = ['chain_proven', 'oracle_resolved'];

function parseEntityRef(value: unknown): EntityRef | null {
  if (!isRecord(value) || typeof value.name !== 'string') return null;
  if (value.kind === 'team' && (value.participant === 1 || value.participant === 2)) {
    return { kind: 'team', participant: value.participant, name: value.name };
  }
  if (value.kind === 'player' && typeof value.normativeId === 'number') {
    const participant =
      value.participant === 1 || value.participant === 2 ? value.participant : null;
    return { kind: 'player', normativeId: value.normativeId, name: value.name, participant };
  }
  return null;
}

function parseAnchor(value: unknown): ClaimAnchor | undefined {
  if (!isRecord(value)) return undefined;
  const { seq, scoreP1, scoreP2 } = value;
  if (typeof seq !== 'number' || typeof scoreP1 !== 'number' || typeof scoreP2 !== 'number') {
    return undefined;
  }
  return { seq, scoreP1, scoreP2 };
}

/** Null when the jsonb doesn't look like a compiled MarketSpec — callers degrade politely. */
export function parseMarketSpec(value: unknown): MarketSpec | null {
  if (!isRecord(value)) return null;
  const claimType = value.claimType;
  if (typeof claimType !== 'string' || !(claimType in TERMS_RENDERERS)) return null;
  const entityRef = parseEntityRef(value.entityRef);
  if (!entityRef) return null;
  if (typeof value.fixtureId !== 'number' || typeof value.threshold !== 'number') return null;
  const comparator = COMPARATORS.find((c) => c === value.comparator);
  const period = PERIODS.find((p) => p === value.period);
  const trustTier = TRUST_TIERS.find((t) => t === value.trustTier);
  if (!comparator || !period || !trustTier) return null;
  return {
    claimType: claimType as ClaimType,
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
