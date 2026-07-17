/**
 * /status live board: public group views over persisted rows only, so the
 * board always reflects settled truth (no in-memory conversation state).
 * Two views: the open-calls board (who called what, who's backing, who's
 * against, matched share) and the match-now scoreline.
 */

import type { PositionSide } from '@calledit/market-engine';
import type { Deps, FixtureRow, GroupRow, MarketRow, PositionRow } from '../ports.js';
import { formatProbabilityPct, statusLine } from './cards.js';
import { formatSolAmount } from '../wager/format.js';

/** Board entries beyond this are summarized — Telegram messages stay scannable. */
const MAX_BOARD_ENTRIES = 8;

/** Bettors named per side before the rest collapse into "+N more". */
const MAX_NAMED_BETTORS_PER_SIDE = 4;

const PHASE_LABEL: Record<string, string> = {
  NS: 'Kickoff soon',
  H1: 'First half',
  HT: 'Half time',
  H2: 'Second half',
  ET1: 'Extra time',
  HTET: 'Extra time break',
  ET2: 'Extra time',
  PE: 'Penalties',
  F: 'Full time',
  FET: 'Full time (AET)',
  FPE: 'Full time (pens)',
  INT: 'Interrupted',
  ABD: 'Abandoned',
  CAN: 'Cancelled',
  POST: 'Postponed',
  COV_LOST: 'Feed interrupted',
};

const TERMINAL_LABELS = new Set(['F', 'FET', 'FPE', 'ABD', 'CAN', 'POST']);

function goalsOf(fixture: FixtureRow): { p1: number; p2: number } | null {
  const score = fixture.score as
    | { p1?: { goals?: unknown }; p2?: { goals?: unknown } }
    | null
    | undefined;
  const p1 = Number(score?.p1?.goals);
  const p2 = Number(score?.p2?.goals);
  return Number.isFinite(p1) && Number.isFinite(p2) ? { p1, p2 } : null;
}

export function scoreline(fixture: FixtureRow): string {
  const goals = goalsOf(fixture);
  return goals === null
    ? `${fixture.p1_name} vs ${fixture.p2_name}`
    : `${fixture.p1_name} ${goals.p1}-${goals.p2} ${fixture.p2_name}`;
}

function phaseLine(fixture: FixtureRow): string {
  const label = PHASE_LABEL[fixture.phase] ?? fixture.phase;
  const minute =
    fixture.minute !== null && !TERMINAL_LABELS.has(fixture.phase) ? `${fixture.minute}' · ` : '';
  return `${minute}${label}`;
}

interface SideSummary {
  lamports: bigint;
  names: string[];
}

/** Who holds a side and for how much, biggest stake first. */
async function summarizeSide(
  deps: Deps,
  positions: PositionRow[],
  side: PositionSide,
): Promise<SideSummary> {
  const stakeByUser = new Map<number, bigint>();
  for (const position of positions) {
    if (position.state === 'void' || position.side !== side) continue;
    const held = stakeByUser.get(position.user_id) ?? 0n;
    stakeByUser.set(position.user_id, held + BigInt(position.stake));
  }
  const ranked = [...stakeByUser.entries()].sort(([, a], [, b]) => (b > a ? 1 : b < a ? -1 : 0));
  const names = await Promise.all(
    ranked.map(async ([userId]) => (await deps.db.getUser(userId))?.display_name ?? 'someone'),
  );
  const lamports = ranked.reduce((total, [, stake]) => total + stake, 0n);
  return { lamports, names };
}

/** "⚡ 0.06 SOL backing: Dee, Sam +2 more", or the empty-side line. */
function sideLine(icon: string, label: string, emptyLine: string, summary: SideSummary): string {
  if (summary.names.length === 0) return `${icon} ${emptyLine}`;
  const named = summary.names.slice(0, MAX_NAMED_BETTORS_PER_SIDE);
  const hidden = summary.names.length - named.length;
  const roster = hidden > 0 ? `${named.join(', ')} +${hidden} more` : named.join(', ');
  return `${icon} ${formatSolAmount(summary.lamports)} ${label}: ${roster}`;
}

/** One board row: the call, its price, and who is on each side of the money. */
async function boardEntry(deps: Deps, index: number, market: MarketRow): Promise<string> {
  const claim = await deps.db.getClaim(market.claim_id);
  const claimer = claim ? await deps.db.getUser(claim.claimer_user_id) : null;
  const positions = await deps.db.positionsForMarket(market.id);
  const [back, doubt] = await Promise.all([
    summarizeSide(deps, positions, 'back'),
    summarizeSide(deps, positions, 'doubt'),
  ]);
  const quoted = claim?.quoted_text ?? 'the call';
  const claimerName = claimer?.display_name ?? 'someone';
  return [
    `${index}. “${quoted}”, called by ${claimerName}`,
    `   📈 ${formatProbabilityPct(market.quote_probability)}% · ${statusLine(market.status)}`,
    `   ${sideLine('⚡', 'backing', 'no backers yet', back)} · ${sideLine('🛑', 'against', 'nobody against yet', doubt)}`,
  ].join('\n');
}

/** Attribution footer: the group always sees whose tap pulled the board up. */
export function boardAttribution(name: string): string {
  return `Pulled up by ${name}.`;
}

/** The open-calls board, posted publicly in the group. */
export async function buildOpenCallsBoard(deps: Deps, group: GroupRow): Promise<string> {
  const markets = await deps.db.openMarketsForGroup(group.id);
  if (markets.length === 0) {
    return '📊 THE BOARD\nNothing on the board right now. Someone make a call.';
  }
  const shown = markets.slice(0, MAX_BOARD_ENTRIES);
  const entries = await Promise.all(
    shown.map((market, position) => boardEntry(deps, position + 1, market)),
  );
  const lines = ['📊 THE BOARD', '', ...entries];
  if (markets.length > shown.length) {
    lines.push('', `…and ${markets.length - shown.length} more on the board.`);
  }
  return lines.join('\n');
}

/** The match-now view: scoreline, minute and phase for the group's match. */
export async function buildMatchNow(
  deps: Deps,
  group: GroupRow,
  replayFixtureId: number | null,
): Promise<string> {
  const markets = await deps.db.openMarketsForGroup(group.id);
  const fixtureIds = new Set<number>(markets.map((market) => market.fixture_id));
  if (replayFixtureId !== null) fixtureIds.add(replayFixtureId);

  const fixtures: FixtureRow[] = [];
  for (const fixtureId of fixtureIds) {
    const fixture = await deps.db.getFixture(fixtureId);
    if (fixture) fixtures.push(fixture);
  }
  if (fixtures.length === 0) {
    return '⚽ MATCH NOW\nNo match on right now. The next kickoff hits the board automatically.';
  }

  const lines = ['⚽ MATCH NOW'];
  for (const fixture of fixtures) {
    const callsOnIt = markets.filter((market) => market.fixture_id === fixture.fixture_id).length;
    const callsLine = callsOnIt > 0 ? ` · ${callsOnIt} call${callsOnIt === 1 ? '' : 's'} open` : '';
    lines.push('', `${scoreline(fixture)}`, `${phaseLine(fixture)}${callsLine}`);
  }
  return lines.join('\n');
}
