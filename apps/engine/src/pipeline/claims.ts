/**
 * Claim lifecycle orchestration: DB rows move
 * detected → nudged → clarifying → awaiting_confirm → confirmed | declined | expired,
 * with candidate MarketSpecs stashed in the claim's jsonb `parse` envelope so
 * every button tap resolves purely against the database (restart-safe).
 */

import type { CompileResult, MarketSpec, PriceQuote, RawClaimParse } from '@calledit/market-engine';
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
  /**
   * tg message id of the most recent confirm-gate post. Tracked so an option
   * switch can strip the superseded gate's keyboard — otherwise its confirm
   * button would mint the NEW terms while displaying the old ones.
   */
  gateMessageId?: number;
}

export function readEnvelope(claim: ClaimRow): ParseEnvelope | null {
  const parsed = claim.parse;
  if (!parsed || typeof parsed !== 'object') return null;
  const env = parsed as Partial<ParseEnvelope>;
  if (!Array.isArray(env.options) || typeof env.kind !== 'string') return null;
  return env as ParseEnvelope;
}

export type ProveOutcome =
  /** The compiler (or model) says no — a terminal, in-character decline. */
  | { kind: 'reject'; message: string }
  /** Infrastructure blinked (LLM/DB) — the prove button stays a valid retry. */
  | { kind: 'retryable' }
  | { kind: 'envelope'; envelope: ParseEnvelope };

/**
 * Parse the quoted text with the agent, then let the deterministic compiler
 * decide (LLM proposes, code disposes). Never throws: infrastructure
 * failures come back as 'retryable' so the caller can restore a live button
 * instead of stranding the claim in 'clarifying'.
 */
export async function proveClaim(deps: Deps, claim: ClaimRow): Promise<ProveOutcome> {
  let raw: RawClaimParse;
  try {
    const seedCtx = await buildCompileContext(deps, null);
    raw = await deps.agent.parse(claim.quoted_text, seedCtx);
  } catch (err) {
    deps.log.warn('parse_failed', { claimId: claim.id, error: String(err) });
    return { kind: 'retryable' };
  }
  deps.log.info('parse', { claimId: claim.id, raw });

  let result: CompileResult;
  try {
    const ctx = await buildCompileContext(deps, raw.fixtureId);
    result = deps.engine.compileClaim(raw, ctx);
  } catch (err) {
    // buildCompileContext reads the DB — a one-off blip must not kill the claim.
    deps.log.warn('compile_context_failed', { claimId: claim.id, error: String(err) });
    return { kind: 'retryable' };
  }
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

/**
 * Pricing-failure taxonomy — three genuinely different situations that must
 * not collapse into one "try again" message:
 * - 'transient':   fetch/DB blinked — retrying the same button can work.
 * - 'no_odds':     the feed has no usable line for this fixture (yet).
 * - 'unpriceable': this spec cannot be priced from the published inputs —
 *                  retrying is pointless; the user needs a different option.
 */
export type QuoteOutcome =
  | { kind: 'ok'; quote: PriceQuote }
  | { kind: 'transient' }
  | { kind: 'no_odds' }
  | { kind: 'unpriceable'; reason: string };

/**
 * The market-engine pricer throws a typed MissingOddsInputError when the feed
 * has not published an input a claim type requires. Detected by name (not
 * instanceof) so the engine stays decoupled from the sibling's class identity.
 */
function isMissingOddsInput(err: unknown): boolean {
  return err instanceof Error && err.name === 'MissingOddsInputError';
}

/** Price a spec off the latest odds snapshot, reporting WHY when it can't. */
export async function quoteSpec(deps: Deps, spec: MarketSpec): Promise<QuoteOutcome> {
  const fetched = await deps.tx.fetchOdds(spec.fixtureId);
  if (fetched.kind !== 'ok') {
    deps.log.info('quote_unavailable', {
      fixtureId: spec.fixtureId,
      claimType: spec.claimType,
      reason: fetched.kind,
    });
    return { kind: fetched.kind };
  }
  let ctx;
  try {
    ctx = await buildCompileContext(deps, spec.fixtureId);
  } catch (err) {
    deps.log.warn('price_context_failed', { fixtureId: spec.fixtureId, error: String(err) });
    return { kind: 'transient' };
  }
  try {
    const quote = deps.engine.priceSpec(spec, fetched.odds, ctx);
    deps.log.info('price', {
      fixtureId: spec.fixtureId,
      claimType: spec.claimType,
      probability: quote.probability,
      multiplier: quote.multiplier,
      provenance: quote.provenance,
    });
    return { kind: 'ok', quote };
  } catch (err) {
    // priceSpec is pure: a throw means this spec cannot be priced from the
    // published inputs. A missing required input may still be published
    // later, so it reads as "no line yet"; anything else is structural.
    deps.log.warn('price_failed', {
      fixtureId: spec.fixtureId,
      claimType: spec.claimType,
      error: String(err),
    });
    return isMissingOddsInput(err)
      ? { kind: 'no_odds' }
      : { kind: 'unpriceable', reason: String(err) };
  }
}

/**
 * A quote at exactly 0 or 1 describes an already-decided (or impossible)
 * claim: minting it would sell unwinnable ×25 backs or guaranteed-loss ×1.02
 * doubts. Checked at the MINT decision points only — the settler deliberately
 * uses honest degenerate reprices for its live card updates.
 */
export function isDegenerateQuote(probability: number): boolean {
  return probability <= 0 || probability >= 1;
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
  // Currency is stamped atomically in the SAME insert (no crash window that
  // could mint a Rep market in a SOL group). With the module null the key is
  // omitted entirely so the insert stays byte-identical to main and works
  // against a pre-0002 schema.
  const currency = await deps.wager?.currencyForMint(claim.group_id);
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
    ...(currency !== undefined ? { currency } : {}),
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
