/**
 * The MarketSpec compiler — the single deterministic gate between LLM output
 * and state. The LLM proposes a RawClaimParse; this module alone decides what
 * becomes a MarketSpec, what needs one clarifying question, what gets the
 * verifiability-negotiation counter-offer, and what is rejected.
 *
 * All consumer-facing copy here is game-show register: no odds notation, no
 * bookie vocabulary, no currency symbols.
 */
import {
  CLAIM_TYPES,
  type ClaimAnchor,
  type ClaimType,
  type Comparator,
  type CompileContext,
  type CompileResult,
  type EntityRef,
  type GamePhase,
  type MarketSpec,
  type Period,
  type PlayerRef,
  type RejectReason,
  type TeamRef,
  type TrustTier,
} from './types.js';
import { TUNABLES } from './constants.js';

// ── Compiler tunables (named, per the no-magic-numbers rule) ──────────────

/** team_scores_n / totals thresholds outside these bounds are nonsense claims. */
const TEAM_GOALS_THRESHOLD_MIN = 1;
const TEAM_GOALS_THRESHOLD_MAX = 10;
const PLAYER_GOALS_THRESHOLD_MIN = 1;
const PLAYER_GOALS_THRESHOLD_MAX = 5;
const TOTALS_LINE_MIN = 0.5;
const TOTALS_LINE_MAX = 9.5;
/** Totals lines must land on half-goal steps (2, 2.5, 3 …) — no quarter lines. */
const TOTALS_LINE_STEP = 0.5;
/** Offered when a totals claim arrives without a number ("goals galore"). */
const TOTALS_CLARIFY_LINES: readonly number[] = [1.5, 2.5, 3.5];

const PRE_MATCH_PHASES: readonly GamePhase[] = ['NS'];
const REGULATION_INPLAY_PHASES: readonly GamePhase[] = ['H1', 'HT', 'H2'];

// ── Monetary-forfeit deny list ────────────────────────────────────────────

const CURRENCY_SYMBOL_PATTERN = /[$£€¥₿₹]/u;
const MONETARY_WORD_PATTERN = new RegExp(
  '\\b(' +
    [
      'dollars?',
      'bucks?',
      'quid',
      'fivers?',
      'tenners?',
      'euros?',
      'pounds?',
      'cents?',
      'pence',
      'usd',
      'eur',
      'gbp',
      'usdc',
      'usdt',
      'sol',
      'eth',
      'btc',
      'bitcoin',
      'crypto',
      'cash',
      'money',
      'venmo',
      'paypal',
      'cashapp',
      'zelle',
      'revolut',
      'wire',
      'pays?',
      'buys?',
      'owes?',
    ].join('|') +
    ')\\b',
  'i',
);

function mentionsMonetaryStake(text: string | null): boolean {
  if (!text) return false;
  return CURRENCY_SYMBOL_PATTERN.test(text) || MONETARY_WORD_PATTERN.test(text);
}

// ── Reject copy (game-show register) ──────────────────────────────────────

const REJECT_COPY: Record<RejectReason, string> = {
  no_fixture:
    "Can't find that match on the card — call it when the fixture's on the slate.",
  unknown_entity: "That name isn't on this card — who are we talking about?",
  unsupported_claim_type:
    "That one's outside my playbook — call a winner, goals, or a scorer and I'm in.",
  monetary_forfeit:
    'Rep only in this game — nothing with a price tag on the line. Keep it social and I will book it.',
  window_closed: 'Calls are locked for this one — that ship has sailed.',
  out_of_range: "That number's off the scale — keep it between the posts.",
  unresolvable:
    "I couldn't pin the terms down — give it to me straight and I'll put a number on it.",
};

const UNKNOWN_PLAYER_COPY =
  "Can't ground him yet — try me once lineups drop.";
const PLAYER_WINDOW_COPY =
  'Scorer calls lock at kickoff — catch him in the next match.';
const COMEBACK_PREMATCH_COPY =
  'A comeback needs a deficit — call it once the match is live and your side is behind.';
const COMEBACK_NOT_TRAILING_COPY =
  "A comeback needs a deficit — you're not behind right now.";
const MINT_CUTOFF_COPY =
  'Too deep into the match to open a new call — calls lock at minute 75.';
const COVERAGE_COPY =
  'Coverage on this match is shaky — no fair market without a clean feed.';

function reject(reason: RejectReason, message?: string): CompileResult {
  return { kind: 'reject', reason, message: message ?? REJECT_COPY[reason] };
}

// ── Entity resolution ─────────────────────────────────────────────────────

function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function namesMatch(a: string, b: string): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na.length === 0 || nb.length === 0) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

type Fixture = NonNullable<CompileContext['fixture']>;

function resolveTeam(name: string, fixture: Fixture): TeamRef | null {
  if (namesMatch(name, fixture.p1Name)) {
    return { kind: 'team', participant: 1, name: fixture.p1Name };
  }
  if (namesMatch(name, fixture.p2Name)) {
    return { kind: 'team', participant: 2, name: fixture.p2Name };
  }
  return null;
}

function resolvePlayer(name: string, ctx: CompileContext): PlayerRef | null {
  const hit = ctx.knownPlayers.find((p) => namesMatch(name, p.name));
  if (!hit) return null;
  return {
    kind: 'player',
    normativeId: hit.normativeId,
    name: hit.name,
    participant: hit.participant,
  };
}

// ── Window checks ─────────────────────────────────────────────────────────

function teamMintWindowOpen(fixture: Fixture): boolean {
  if (PRE_MATCH_PHASES.includes(fixture.phase)) return true;
  if (REGULATION_INPLAY_PHASES.includes(fixture.phase)) {
    return (
      fixture.minute === null ||
      fixture.minute <= TUNABLES.INPLAY_MINT_CUTOFF_MINUTE
    );
  }
  return false;
}

function isPreKickoff(fixture: Fixture, nowMs: number): boolean {
  return PRE_MATCH_PHASES.includes(fixture.phase) && nowMs < fixture.kickoffMs;
}

// ── Threshold validation ──────────────────────────────────────────────────

function isOnStep(value: number, step: number): boolean {
  const scaled = value / step;
  return Math.abs(scaled - Math.round(scaled)) < 1e-9;
}

function validIntThreshold(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

// ── Spec construction ─────────────────────────────────────────────────────

function trustTierFor(claimType: ClaimType): TrustTier {
  return claimType === 'player_scores_n' ? 'oracle_resolved' : 'chain_proven';
}

function buildSpec(args: {
  claimType: ClaimType;
  fixtureId: number;
  entityRef: EntityRef;
  comparator: Comparator;
  threshold: number;
  period: Period;
  anchor?: ClaimAnchor;
}): MarketSpec {
  const spec: MarketSpec = {
    claimType: args.claimType,
    fixtureId: args.fixtureId,
    entityRef: args.entityRef,
    comparator: args.comparator,
    threshold: args.threshold,
    period: args.period,
    trustTier: trustTierFor(args.claimType),
  };
  if (args.anchor) spec.anchor = args.anchor;
  return spec;
}

// ── The compiler ──────────────────────────────────────────────────────────

export function compileClaim(
  parse: import('./types.js').RawClaimParse,
  ctx: CompileContext,
): CompileResult {
  // Compliance gate first: monetary stakes are refused before anything else.
  if (mentionsMonetaryStake(parse.unresolved)) {
    return reject('monetary_forfeit');
  }

  const claimType = parse.claimType;
  if (claimType === null) {
    return parse.unresolved
      ? reject('unresolvable')
      : reject('unsupported_claim_type');
  }
  if (!CLAIM_TYPES.includes(claimType)) {
    return reject('unsupported_claim_type');
  }

  const fixture = ctx.fixture;
  if (!fixture) return reject('no_fixture');
  if (parse.fixtureId !== null && parse.fixtureId !== fixture.fixtureId) {
    return reject('no_fixture');
  }
  if (fixture.coverageUnreliable) {
    return reject('window_closed', COVERAGE_COPY);
  }

  switch (claimType) {
    case 'match_winner':
      return compileMatchWinner(parse, fixture);
    case 'totals_ou':
      return compileTotals(parse, fixture);
    case 'team_scores_n':
      return compileTeamScoresN(parse, fixture);
    case 'btts':
      return compileBtts(parse, fixture);
    case 'comeback':
      return compileComeback(parse, fixture);
    case 'player_scores_n':
      return compilePlayerScoresN(parse, fixture, ctx);
  }
}

function requireTeam(
  parse: import('./types.js').RawClaimParse,
  fixture: Fixture,
): TeamRef | CompileResult {
  if (!parse.entityName) return reject('unknown_entity');
  const team = resolveTeam(parse.entityName, fixture);
  if (!team) return reject('unknown_entity');
  return team;
}

function compileMatchWinner(
  parse: import('./types.js').RawClaimParse,
  fixture: Fixture,
): CompileResult {
  if (!teamMintWindowOpen(fixture)) {
    return reject('window_closed', MINT_CUTOFF_COPY);
  }
  const team = requireTeam(parse, fixture);
  if (!('kind' in team) || team.kind !== 'team') return team as CompileResult;

  const base = {
    claimType: 'match_winner' as const,
    fixtureId: fixture.fixtureId,
    entityRef: team,
    comparator: 'gte' as const,
    threshold: 1,
  };

  if (parse.period === null) {
    // Knockout football: "win" is ambiguous between 90 minutes and advancing.
    return {
      kind: 'clarify',
      question: `${team.name} to win — in 90 minutes, or advancing however it takes?`,
      options: [
        {
          label: 'In 90 minutes',
          spec: buildSpec({ ...base, period: 'FT_90' }),
        },
        {
          label: 'Advancing — extra time and shootout count',
          spec: buildSpec({ ...base, period: 'FT' }),
        },
      ],
    };
  }
  return { kind: 'ok', spec: buildSpec({ ...base, period: parse.period }) };
}

function compileTotals(
  parse: import('./types.js').RawClaimParse,
  fixture: Fixture,
): CompileResult {
  if (!teamMintWindowOpen(fixture)) {
    return reject('window_closed', MINT_CUTOFF_COPY);
  }
  // Totals claims are about the whole match; a team mention (if any) does not
  // change the market. Entity is pinned to participant 1 by convention and
  // ignored at settlement.
  const entityRef: TeamRef = { kind: 'team', participant: 1, name: fixture.p1Name };
  const comparator = parse.comparator ?? 'gte';
  const period = parse.period ?? 'FT_90';

  if (parse.threshold === null) {
    const word = comparator === 'lte' ? 'Under' : 'Over';
    return {
      kind: 'clarify',
      question: `Goals claim — where's the line?`,
      options: TOTALS_CLARIFY_LINES.map((line) => ({
        label: `${word} ${line}`,
        spec: buildSpec({
          claimType: 'totals_ou',
          fixtureId: fixture.fixtureId,
          entityRef,
          comparator,
          threshold: line,
          period,
        }),
      })),
    };
  }

  const line = parse.threshold;
  if (
    !isOnStep(line, TOTALS_LINE_STEP) ||
    line < TOTALS_LINE_MIN ||
    line > TOTALS_LINE_MAX
  ) {
    return reject('out_of_range');
  }
  // "Exactly N.5 goals" can never happen — an eq claim needs a whole number.
  if (comparator === 'eq' && !Number.isInteger(line)) {
    return reject('out_of_range');
  }
  return {
    kind: 'ok',
    spec: buildSpec({
      claimType: 'totals_ou',
      fixtureId: fixture.fixtureId,
      entityRef,
      comparator,
      threshold: line,
      period,
    }),
  };
}

function compileTeamScoresN(
  parse: import('./types.js').RawClaimParse,
  fixture: Fixture,
): CompileResult {
  if (!teamMintWindowOpen(fixture)) {
    return reject('window_closed', MINT_CUTOFF_COPY);
  }
  const team = requireTeam(parse, fixture);
  if (!('kind' in team) || team.kind !== 'team') return team as CompileResult;

  const threshold = parse.threshold ?? TEAM_GOALS_THRESHOLD_MIN;
  if (
    !validIntThreshold(threshold, TEAM_GOALS_THRESHOLD_MIN, TEAM_GOALS_THRESHOLD_MAX)
  ) {
    return reject('out_of_range');
  }
  return {
    kind: 'ok',
    spec: buildSpec({
      claimType: 'team_scores_n',
      fixtureId: fixture.fixtureId,
      entityRef: team,
      comparator: parse.comparator ?? 'gte',
      threshold,
      period: parse.period ?? 'FT_90',
    }),
  };
}

function compileBtts(
  parse: import('./types.js').RawClaimParse,
  fixture: Fixture,
): CompileResult {
  if (!teamMintWindowOpen(fixture)) {
    return reject('window_closed', MINT_CUTOFF_COPY);
  }
  const entityRef: TeamRef = { kind: 'team', participant: 1, name: fixture.p1Name };
  return {
    kind: 'ok',
    spec: buildSpec({
      claimType: 'btts',
      fixtureId: fixture.fixtureId,
      entityRef,
      comparator: 'gte',
      threshold: 1,
      period: parse.period ?? 'FT_90',
    }),
  };
}

function compileComeback(
  parse: import('./types.js').RawClaimParse,
  fixture: Fixture,
): CompileResult {
  if (PRE_MATCH_PHASES.includes(fixture.phase)) {
    return reject('window_closed', COMEBACK_PREMATCH_COPY);
  }
  if (!teamMintWindowOpen(fixture)) {
    return reject('window_closed', MINT_CUTOFF_COPY);
  }
  const team = requireTeam(parse, fixture);
  if (!('kind' in team) || team.kind !== 'team') return team as CompileResult;

  const own =
    team.participant === 1 ? fixture.score.p1Goals : fixture.score.p2Goals;
  const opp =
    team.participant === 1 ? fixture.score.p2Goals : fixture.score.p1Goals;
  if (own >= opp) {
    return reject('window_closed', COMEBACK_NOT_TRAILING_COPY);
  }

  const anchor: ClaimAnchor = {
    seq: fixture.lastSeq,
    scoreP1: fixture.score.p1Goals,
    scoreP2: fixture.score.p2Goals,
  };
  return {
    kind: 'ok',
    spec: buildSpec({
      claimType: 'comeback',
      fixtureId: fixture.fixtureId,
      entityRef: team,
      comparator: 'gte',
      threshold: 1,
      period: parse.period ?? 'FT',
      anchor,
    }),
  };
}

function compilePlayerScoresN(
  parse: import('./types.js').RawClaimParse,
  fixture: Fixture,
  ctx: CompileContext,
): CompileResult {
  if (!isPreKickoff(fixture, ctx.nowMs)) {
    return reject('window_closed', PLAYER_WINDOW_COPY);
  }
  if (!parse.entityName) {
    return reject('unknown_entity', UNKNOWN_PLAYER_COPY);
  }
  const player = resolvePlayer(parse.entityName, ctx);
  if (!player) {
    return reject('unknown_entity', UNKNOWN_PLAYER_COPY);
  }

  const threshold = parse.threshold ?? PLAYER_GOALS_THRESHOLD_MIN;
  if (
    !validIntThreshold(
      threshold,
      PLAYER_GOALS_THRESHOLD_MIN,
      PLAYER_GOALS_THRESHOLD_MAX,
    )
  ) {
    return reject('out_of_range');
  }

  const period = parse.period ?? 'FT_90';
  const asStated = buildSpec({
    claimType: 'player_scores_n',
    fixtureId: fixture.fixtureId,
    entityRef: player,
    comparator: parse.comparator ?? 'gte',
    threshold,
    period,
  });

  // Verifiability negotiation: player stats are not chain-provable (on-chain
  // stat keys are team-level), so offer the honest as-stated tier plus a
  // chain-proven team upgrade — but only when we know which side he plays for.
  if (player.participant === null) {
    return { kind: 'ok', spec: asStated };
  }

  const teamName =
    player.participant === 1 ? fixture.p1Name : fixture.p2Name;
  const upgrade = buildSpec({
    claimType: 'team_scores_n',
    fixtureId: fixture.fixtureId,
    entityRef: { kind: 'team', participant: player.participant, name: teamName },
    comparator: 'gte',
    threshold,
    period,
  });
  const plural = threshold === 1 ? 'goal' : 'goals';
  return {
    kind: 'counter_offer',
    reason:
      `I can't chain-prove ${player.name} personally — on-chain stats are team-level. ` +
      `Book it Oracle-resolved as stated, or upgrade to "${teamName} scores ${threshold}+ ${plural}" Chain-proven?`,
    asStated,
    upgrade,
  };
}
