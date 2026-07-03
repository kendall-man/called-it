/**
 * Claim lifecycle orchestration: DB rows move
 * detected → nudged → clarifying → awaiting_confirm → confirmed | declined | expired,
 * with candidate MarketSpecs stashed in the claim's jsonb `parse` envelope so
 * every button tap resolves purely against the database (restart-safe).
 */

import type { MarketSpec, PriceQuote, RawClaimParse } from '@calledit/market-engine';
import { TUNABLES } from '@calledit/market-engine';
import type { ClaimRow, Deps, FixtureRow, GroupRow, MarketRow } from '../ports.js';
import { buildCompileContext, readGoals } from './context.js';

/** Stored in claims.parse (jsonb): the raw parse plus compiled candidates. */
export interface ParseEnvelope {
  raw: RawClaimParse | null;
  kind: 'ok' | 'clarify' | 'counter_offer';
  question?: string;
  reason?: string;
  options: Array<{ key: string; label: string; spec: MarketSpec }>;
  chosen?: MarketSpec;
  quote?: {
    probability: number;
    multiplier: number;
    provenance: 'market' | 'modelled';
    oddsMessageId: string | null;
    oddsTsMs: number | null;
  };
}

export function readEnvelope(claim: ClaimRow): ParseEnvelope | null {
  const parsed = claim.parse;
  if (!parsed || typeof parsed !== 'object') return null;
  const env = parsed as Partial<ParseEnvelope>;
  if (!Array.isArray(env.options) || typeof env.kind !== 'string') return null;
  return env as ParseEnvelope;
}

export type ProveOutcome =
  | { kind: 'reject'; message: string }
  | { kind: 'envelope'; envelope: ParseEnvelope };

/**
 * Parse the quoted text with the agent, then let the deterministic compiler
 * decide (LLM proposes, code disposes). Never throws for model failures.
 */
export async function proveClaim(deps: Deps, claim: ClaimRow): Promise<ProveOutcome> {
  let raw: RawClaimParse;
  try {
    const seedCtx = await buildCompileContext(deps, null);
    raw = await deps.agent.parse(claim.quoted_text, seedCtx);
  } catch (err) {
    deps.log.warn('parse_failed', { claimId: claim.id, error: String(err) });
    return { kind: 'reject', message: "Couldn't pin that one down — give it to me one more time." };
  }
  deps.log.info('parse', { claimId: claim.id, raw });

  const ctx = await buildCompileContext(deps, raw.fixtureId);
  const result = deps.engine.compileClaim(raw, ctx);
  deps.log.info('compile', { claimId: claim.id, resultKind: result.kind });

  switch (result.kind) {
    case 'ok':
      return {
        kind: 'envelope',
        envelope: { raw, kind: 'ok', options: [{ key: 'ok', label: 'As stated', spec: result.spec }] },
      };
    case 'clarify':
      return {
        kind: 'envelope',
        envelope: {
          raw,
          kind: 'clarify',
          question: result.question,
          options: result.options.map((option, index) => ({
            key: String(index),
            label: option.label,
            spec: option.spec,
          })),
        },
      };
    case 'counter_offer': {
      const options: ParseEnvelope['options'] = [];
      if (result.asStated) {
        options.push({ key: 'as', label: 'Book it as stated · Oracle-resolved', spec: result.asStated });
      }
      options.push({ key: 'up', label: 'Take the upgrade · Chain-proven', spec: result.upgrade });
      return {
        kind: 'envelope',
        envelope: { raw, kind: 'counter_offer', reason: result.reason, options },
      };
    }
    case 'reject':
      return { kind: 'reject', message: result.message };
  }
}

/** Price a spec off the latest odds snapshot; null when no clean number exists. */
export async function quoteSpec(deps: Deps, spec: MarketSpec): Promise<PriceQuote | null> {
  try {
    const odds = await deps.tx.fetchOdds(spec.fixtureId);
    if (!odds) return null;
    const ctx = await buildCompileContext(deps, spec.fixtureId);
    const quote = deps.engine.priceSpec(spec, odds, ctx);
    deps.log.info('price', {
      fixtureId: spec.fixtureId,
      claimType: spec.claimType,
      probability: quote.probability,
      multiplier: quote.multiplier,
      provenance: quote.provenance,
    });
    return quote;
  } catch (err) {
    deps.log.warn('price_failed', { fixtureId: spec.fixtureId, error: String(err) });
    return null;
  }
}

export type MintWindowCheck = { open: true } | { open: false; reason: string };

/**
 * Cheap re-validation at confirm time (the compiler already ran full window
 * checks at parse time; minutes may have passed since).
 */
export function checkMintWindow(
  spec: MarketSpec,
  fixture: FixtureRow | null,
  nowMs: number,
): MintWindowCheck {
  if (!fixture) return { open: false, reason: 'fixture unknown' };
  const kickoffMs = fixture.kickoff_at ? Date.parse(fixture.kickoff_at) : null;
  const started = fixture.phase !== 'NS';
  if (spec.claimType === 'player_scores_n') {
    if (started || (kickoffMs !== null && nowMs >= kickoffMs)) {
      return { open: false, reason: 'player calls close at kickoff' };
    }
    return { open: true };
  }
  if (started && fixture.minute !== null && fixture.minute >= TUNABLES.INPLAY_MINT_CUTOFF_MINUTE) {
    return { open: false, reason: 'in-play minting is closed for this match' };
  }
  if (spec.claimType === 'comeback') {
    // In-play only, and only while the claimed team still trails.
    if (!started) return { open: false, reason: 'comeback calls are in-play only' };
    if (spec.entityRef.kind === 'team') {
      const score = (fixture.score ?? {}) as Record<string, unknown>;
      const own = readGoals(score, spec.entityRef.participant === 1 ? 'p1' : 'p2');
      const other = readGoals(score, spec.entityRef.participant === 1 ? 'p2' : 'p1');
      if (own >= other) return { open: false, reason: 'no longer trailing' };
    }
  }
  return { open: true };
}

export interface CreateMarketArgs {
  claim: ClaimRow;
  group: GroupRow;
  spec: MarketSpec;
  quote: NonNullable<ParseEnvelope['quote']>;
  isReplay: boolean;
  fixture: FixtureRow;
}

/** The confirm tap made it real: persist the market row. */
export async function createMarketFromClaim(deps: Deps, args: CreateMarketArgs): Promise<MarketRow> {
  const { claim, spec, quote, isReplay, fixture } = args;
  const needsLineup =
    spec.claimType === 'player_scores_n' &&
    (spec.entityRef.kind !== 'player' || spec.entityRef.participant === null) &&
    fixture.phase === 'NS';
  const market = await deps.db.insertMarket({
    claim_id: claim.id,
    group_id: claim.group_id,
    fixture_id: spec.fixtureId,
    spec,
    status: needsLineup ? 'pending_lineup' : 'open',
    is_replay: isReplay,
    price_provenance: quote.provenance,
    quote_probability: quote.probability,
    quote_multiplier: quote.multiplier,
    odds_message_id: quote.oddsMessageId,
    odds_ts: quote.oddsTsMs,
  });
  await deps.db.updateClaim(claim.id, { status: 'confirmed' });
  deps.log.info('market_minted', {
    marketId: market.id,
    claimId: claim.id,
    groupId: claim.group_id,
    fixtureId: spec.fixtureId,
    claimType: spec.claimType,
    status: market.status,
    isReplay,
  });
  return market;
}

/** Rep multiplier for the doubting side at the quoted claim probability. */
export function doubtMultiplier(probability: number): number {
  const complement = 1 - probability;
  if (complement <= 0) return TUNABLES.MULTIPLIER_MIN;
  const raw = 1 / complement;
  return Math.min(TUNABLES.MULTIPLIER_MAX, Math.max(TUNABLES.MULTIPLIER_MIN, raw));
}
