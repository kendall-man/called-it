import type { GamePhase, MatchEvent, OddsInputs, ScoreState } from '@calledit/market-engine';
import { PCT_TO_PROBABILITY_DIVISOR, PROBABILITY_SUM_TOLERANCE } from './constants.js';
import { consoleLogger, type TxlineLogger } from './logging.js';
import { oddsRecordSchema, type OddsRecord } from './schemas.js';

/**
 * Odds normalization: TxLINE StablePrice records → domain OddsInputs.
 *
 * SuperOddsType strings are inventoried empirically (the spec types them as
 * plain strings), so classification is two-layered: a generous alias table
 * first, then a structural fallback on PriceNames. Unknown types are logged
 * and skipped — never thrown.
 */

// ── market classification ─────────────────────────────────────────────────

export type OddsMarketKind = '1x2' | 'totals';

const normalizeToken = (value: string): string => value.toUpperCase().replace(/[^A-Z0-9]/g, '');

const ONE_X_TWO_TYPE_ALIASES = new Set(
  [
    '1X2',
    '3W',
    'WDW',
    'MR',
    'MRES',
    'MATCHRESULT',
    'FT1X2',
    '1X2FT',
    'MATCHODDS',
    // Devnet empirical (2026-07-03): the StablePrice match-result type.
    '1X2_PARTICIPANT_RESULT',
  ].map(normalizeToken),
);
const TOTALS_TYPE_ALIASES = new Set(
  [
    'OU',
    'OVERUNDER',
    'TOTAL',
    'TOTALS',
    'TOTALGOALS',
    'TG',
    'GOALS',
    'GOALSOU',
    'TO',
    // Devnet empirical: match total goals despite the "PARTICIPANT" in the
    // name — records carry a single line ladder with no per-team selector.
    'OVERUNDER_PARTICIPANT_GOALS',
  ].map(normalizeToken),
);

/**
 * Types we recognize but deliberately do not price (no domain market uses
 * them). Classified as null WITHOUT the unknown-type log — the devnet feed
 * publishes these on every fixture and the log otherwise floods every poll.
 */
const KNOWN_UNPRICED_TYPE_ALIASES = new Set(
  ['AH', 'ASIANHANDICAP', 'HANDICAP', 'ASIANHANDICAP_PARTICIPANT_GOALS'].map(normalizeToken),
);

const HOME_PRICE_NAMES = new Set(['1', 'HOME', 'H', 'P1', 'PART1']);
const DRAW_PRICE_NAMES = new Set(['X', 'DRAW', 'D']);
const AWAY_PRICE_NAMES = new Set(['2', 'AWAY', 'A', 'P2', 'PART2']);
const OVER_PRICE_NAMES = new Set(['OVER', 'O']);
const UNDER_PRICE_NAMES = new Set(['UNDER', 'U']);

function classifyByPriceNames(priceNames: string[] | null | undefined): OddsMarketKind | null {
  if (priceNames == null) return null;
  const names = priceNames.map(normalizeToken);
  if (
    names.length === 3 &&
    names.some((n) => HOME_PRICE_NAMES.has(n)) &&
    names.some((n) => DRAW_PRICE_NAMES.has(n)) &&
    names.some((n) => AWAY_PRICE_NAMES.has(n))
  ) {
    return '1x2';
  }
  if (
    names.length === 2 &&
    names.some((n) => OVER_PRICE_NAMES.has(n)) &&
    names.some((n) => UNDER_PRICE_NAMES.has(n))
  ) {
    return 'totals';
  }
  return null;
}

/**
 * Classifies an odds record as one of the markets we price from.
 * Logs (once per call) when SuperOddsType is not in the alias inventory.
 */
export function classifyOddsRecord(record: OddsRecord, logger: TxlineLogger = consoleLogger): OddsMarketKind | null {
  const token = normalizeToken(record.SuperOddsType);
  if (ONE_X_TWO_TYPE_ALIASES.has(token)) return '1x2';
  if (TOTALS_TYPE_ALIASES.has(token)) return 'totals';
  if (KNOWN_UNPRICED_TYPE_ALIASES.has(token)) return null;
  const structural = classifyByPriceNames(record.PriceNames);
  logger('unknown SuperOddsType', {
    superOddsType: record.SuperOddsType,
    structuralFallback: structural,
  });
  return structural;
}

// ── period filtering ──────────────────────────────────────────────────────

/**
 * MarketPeriod values that clearly denote a partial-match market. "ET"
 * (observed live 2026-07-03 when a friendly went to extra time) prices the
 * extra-time segment only — not our 90-minute/full-match inputs.
 */
const PARTIAL_MATCH_PERIOD_PATTERN =
  /^(1H|2H|H1|H2|HT|1ST|2ND|FIRSTHALF|SECONDHALF|HALF\d|ET|AET|OT|EXTRATIME)/;

/**
 * StablePrice 1X2 is a 90-minute market; we only price from full-match
 * periods. Unknown period strings are accepted with a log (rejecting them
 * could silently zero out all odds if TxLINE uses an unexpected label).
 *
 * Devnet empirical (2026-07-03): the wire uses a key=value grammar — absent
 * period means full match, "half=1" means first half. Any "half=N" is
 * partial; other key=value forms are unfamiliar-but-accepted like unknown
 * plain tokens.
 */
export function isFullMatchPeriod(
  marketPeriod: string | null | undefined,
  logger: TxlineLogger = consoleLogger,
): boolean {
  if (marketPeriod == null || marketPeriod === '') return true;
  const equalsIndex = marketPeriod.indexOf('=');
  if (equalsIndex !== -1) {
    const key = marketPeriod.slice(0, equalsIndex).trim().toLowerCase();
    if (key === 'half') return false;
    logger('unfamiliar key=value MarketPeriod — treating as full match', { marketPeriod });
    return true;
  }
  const token = normalizeToken(marketPeriod);
  if (PARTIAL_MATCH_PERIOD_PATTERN.test(token)) return false;
  const KNOWN_FULL_MATCH_TOKENS = new Set(['M', 'FT', 'MATCH', 'FULL', 'FULLTIME', '90', 'REG', 'REGULAR']);
  if (!KNOWN_FULL_MATCH_TOKENS.has(token)) {
    logger('unfamiliar MarketPeriod — treating as full match', { marketPeriod });
  }
  return true;
}

// ── suspension detection ──────────────────────────────────────────────────

const SUSPENDED_GAME_STATE_PATTERN = /susp|otb|off.?the.?board|stop/i;

/** True when the record's GameState marks the market off the board. */
export function isOddsSuspended(record: OddsRecord): boolean {
  return typeof record.GameState === 'string' && SUSPENDED_GAME_STATE_PATTERN.test(record.GameState);
}

// ── Pct parsing ───────────────────────────────────────────────────────────

function pctToProbability(pct: string | null | undefined): number | null {
  if (pct == null || pct === 'NA') return null;
  const parsed = Number.parseFloat(pct);
  if (Number.isNaN(parsed)) return null;
  return parsed / PCT_TO_PROBABILITY_DIVISOR;
}

function indexOfName(names: string[] | null | undefined, aliases: Set<string>, fallbackIndex: number): number {
  if (names == null) return fallbackIndex;
  const index = names.findIndex((n) => aliases.has(normalizeToken(n)));
  return index === -1 ? fallbackIndex : index;
}

/** First decimal number inside MarketParameters (e.g. "line=2.5", "2.5"). */
export function parseTotalsLine(marketParameters: string | null | undefined): number | null {
  if (marketParameters == null) return null;
  const match = marketParameters.match(/-?\d+(?:\.\d+)?/);
  if (match === null) return null;
  return Number.parseFloat(match[0]);
}

// ── normalizeOdds ─────────────────────────────────────────────────────────

export interface NormalizeOddsOptions {
  logger?: TxlineLogger;
}

const ONE_X_TWO_OUTCOME_COUNT = 3;
const TOTALS_OUTCOME_COUNT = 2;

/**
 * Normalizes a single TxLINE odds record into OddsInputs. Returns null when
 * the record is not a usable full-match 1X2/totals price (unknown market,
 * partial period, suspended, or NA percentages such as quarter lines).
 * A non-null result fills exactly one of `p1x2` / `totals` and always pins
 * MessageId/Ts for later /api/odds/validation proofs.
 */
export function normalizeOdds(payload: unknown, options: NormalizeOddsOptions = {}): OddsInputs | null {
  const logger = options.logger ?? consoleLogger;
  const parsed = oddsRecordSchema.safeParse(payload);
  if (!parsed.success) {
    logger('skipping unparseable odds record', {
      issues: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`),
    });
    return null;
  }
  const record = parsed.data;

  const marketKind = classifyOddsRecord(record, logger);
  if (marketKind === null) return null;
  if (!isFullMatchPeriod(record.MarketPeriod, logger)) return null;
  if (isOddsSuspended(record)) return null;

  const probabilities = (record.Pct ?? []).map((pct) => pctToProbability(pct));

  if (marketKind === '1x2') {
    if (probabilities.length < ONE_X_TWO_OUTCOME_COUNT) return null;
    const home = probabilities[indexOfName(record.PriceNames, HOME_PRICE_NAMES, 0)] ?? null;
    const draw = probabilities[indexOfName(record.PriceNames, DRAW_PRICE_NAMES, 1)] ?? null;
    const away = probabilities[indexOfName(record.PriceNames, AWAY_PRICE_NAMES, 2)] ?? null;
    if (home === null || draw === null || away === null) return null;
    const sum = home + draw + away;
    if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) {
      logger('1X2 probabilities do not sum to ~1', { sum, messageId: record.MessageId });
    }
    return {
      p1x2: { home, draw, away },
      totals: null,
      oddsMessageId: record.MessageId,
      oddsTsMs: record.Ts,
    };
  }

  // totals
  const line = parseTotalsLine(record.MarketParameters);
  if (line === null) {
    logger('totals record without a parseable line', { messageId: record.MessageId });
    return null;
  }
  if (probabilities.length < TOTALS_OUTCOME_COUNT) return null;
  const overProb = probabilities[indexOfName(record.PriceNames, OVER_PRICE_NAMES, 0)] ?? null;
  if (overProb === null) return null; // "NA" — quarter lines etc.
  return {
    p1x2: null,
    totals: { line, overProb },
    oddsMessageId: record.MessageId,
    oddsTsMs: record.Ts,
  };
}

// ── snapshot combination ──────────────────────────────────────────────────

/** The most informative totals line is the one closest to even money. */
const MAIN_LINE_TARGET_PROBABILITY = 0.5;

/** Half-goal lines have no push outcome, so their Pct is unconditional. */
const isHalfGoalLine = (line: number): boolean => Math.abs(line * 2 - Math.round(line * 2)) < 1e-9 && Math.round(line * 2) % 2 === 1;

/**
 * Combines an odds snapshot (array of records, one per market line) into a
 * single OddsInputs: latest full-match 1X2 by Ts + the main totals line
 * (over-probability closest to 0.5, latest Ts breaking ties). Half-goal
 * lines are preferred over integer lines: integer-line Pcts are
 * push-conditioned (P(over | no push)) and systematically overstate the
 * unconditional over probability the Poisson inversion expects — an integer
 * line is used only when no half-goal line has a usable Pct. Provenance is
 * pinned from the 1X2 record when present, else the totals record.
 * Returns null when nothing in the snapshot is usable.
 */
export function combineOddsSnapshot(payloads: unknown[], options: NormalizeOddsOptions = {}): OddsInputs | null {
  let best1x2: OddsInputs | null = null;
  let bestHalfLine: OddsInputs | null = null;
  let bestIntegerLine: OddsInputs | null = null;

  const closerToEvenMoney = (candidate: OddsInputs, incumbent: OddsInputs | null): boolean => {
    if (incumbent === null) return true;
    const currentDistance = Math.abs((incumbent.totals?.overProb ?? 0) - MAIN_LINE_TARGET_PROBABILITY);
    const candidateDistance = Math.abs((candidate.totals?.overProb ?? 0) - MAIN_LINE_TARGET_PROBABILITY);
    return (
      candidateDistance < currentDistance ||
      (candidateDistance === currentDistance && (candidate.oddsTsMs ?? 0) > (incumbent.oddsTsMs ?? 0))
    );
  };

  for (const payload of payloads) {
    const inputs = normalizeOdds(payload, options);
    if (inputs === null) continue;
    if (inputs.p1x2 !== null) {
      if (best1x2 === null || (inputs.oddsTsMs ?? 0) > (best1x2.oddsTsMs ?? 0)) best1x2 = inputs;
    } else if (inputs.totals !== null) {
      if (isHalfGoalLine(inputs.totals.line)) {
        if (closerToEvenMoney(inputs, bestHalfLine)) bestHalfLine = inputs;
      } else if (closerToEvenMoney(inputs, bestIntegerLine)) {
        bestIntegerLine = inputs;
      }
    }
  }

  const bestTotals = bestHalfLine ?? bestIntegerLine;
  if (best1x2 === null && bestTotals === null) return null;
  const pinSource = best1x2 ?? bestTotals;
  return {
    p1x2: best1x2?.p1x2 ?? null,
    totals: bestTotals?.totals ?? null,
    oddsMessageId: pinSource?.oddsMessageId ?? null,
    oddsTsMs: pinSource?.oddsTsMs ?? null,
  };
}

// ── suspension MatchEvent ─────────────────────────────────────────────────

const EMPTY_TEAM_STATS = { goals: 0, yellowCards: 0, redCards: 0, corners: 0 };
const UNKNOWN_SCORE_STATE: ScoreState = {
  p1: EMPTY_TEAM_STATS,
  p2: EMPTY_TEAM_STATS,
  p1Goals90: null,
  p2Goals90: null,
};

export interface OddsEventEnrichment {
  phase?: GamePhase;
  score?: ScoreState;
}

/**
 * Builds an `odds_suspension` MatchEvent from a suspended odds record. Odds
 * records carry no per-fixture seq, so the record's Ts (ms) doubles as the
 * seq — far above any scores seq, preserving (fixtureId, seq) uniqueness.
 * Phase/score should be enriched from the scores stream when known.
 */
export function buildOddsSuspensionEvent(
  record: OddsRecord,
  receivedAtMs: number,
  enrichment: OddsEventEnrichment = {},
): MatchEvent {
  return {
    kind: 'odds_suspension',
    fixtureId: record.FixtureId,
    seq: record.Ts,
    tsMs: record.Ts,
    receivedAtMs,
    confirmed: true,
    phase: enrichment.phase ?? 'NS',
    minute: null,
    score: enrichment.score ?? UNKNOWN_SCORE_STATE,
  };
}
