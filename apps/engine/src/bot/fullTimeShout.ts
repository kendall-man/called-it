/**
 * Full-time recap: the celebratory post that lands when a match finishes,
 * praising the members whose calls (or fades) paid out. Deterministic copy;
 * the exact-money sentences come from the wager module's payout lines and are
 * never LLM-garnished.
 */

import type { SettlementOutcome } from '@calledit/market-engine';
import type { ClaimRow, FixtureRow, MarketRow, SettlementRow, UserRow } from '../ports.js';
import { scoreline } from './statusBoard.js';

/**
 * Settlement rows are stamped by the database clock while the replay start is
 * engine wall clock; the lookback absorbs skew between the two so a call
 * settled in the opening seconds still makes the recap.
 */
const CLOCK_SKEW_LOOKBACK_MS = 60_000;

/** Recap entries beyond this are summarized so the post stays scannable. */
const MAX_SHOUT_ENTRIES = 6;

/** Winners lead the post, then the fallen calls, then anything called off. */
const OUTCOME_ORDER: Record<SettlementOutcome, number> = {
  claim_won: 0,
  claim_lost: 1,
  void: 2,
};

/** Structural slice of Deps['db'] — tests fake exactly this surface. */
export interface FullTimeShoutDb {
  getFixture(fixtureId: number): Promise<FixtureRow | null>;
  settlementsSince(sinceIso: string): Promise<SettlementRow[]>;
  getMarket(marketId: string): Promise<MarketRow | null>;
  getClaim(claimId: string): Promise<ClaimRow | null>;
  getUser(id: number): Promise<UserRow | null>;
}

/** Structural slice of the wager module: the exact-money payout sentence. */
export interface FullTimeShoutWager {
  settlementPayoutsLine(marketId: string, outcome: SettlementOutcome): Promise<string>;
}

function entryLine(
  outcome: SettlementOutcome,
  quoted: string,
  claimerName: string,
  moneyLine: string,
): string {
  switch (outcome) {
    case 'claim_won':
      return `🗣️ ${claimerName} CALLED IT: “${quoted}”. ${moneyLine} Take a bow.`;
    case 'claim_lost':
      return `💀 “${quoted}” never landed. ${moneyLine} Chin up, ${claimerName}: the next call is yours.`;
    case 'void':
      return `↩️ “${quoted}”: ${moneyLine}`;
  }
}

/**
 * The full-time shout for one group's finished match, or null when none of the
 * group's calls settled during it (the caller falls back to the plain line).
 * Reads only rows settled after the match started, so an earlier run of the
 * same fixture can't leak old winners into tonight's recap.
 */
export async function buildFullTimeShout(
  db: FullTimeShoutDb,
  wager: FullTimeShoutWager,
  args: { groupId: number; fixtureId: number; matchStartedAtMs: number },
): Promise<string | null> {
  const sinceIso = new Date(args.matchStartedAtMs - CLOCK_SKEW_LOOKBACK_MS).toISOString();
  const settlements = await db.settlementsSince(sinceIso);

  const settled: Array<{ settlement: SettlementRow; market: MarketRow }> = [];
  for (const settlement of settlements) {
    const market = await db.getMarket(settlement.market_id);
    if (!market || market.fixture_id !== args.fixtureId || market.group_id !== args.groupId) {
      continue;
    }
    settled.push({ settlement, market });
  }
  if (settled.length === 0) return null;

  settled.sort((a, b) => OUTCOME_ORDER[a.settlement.outcome] - OUTCOME_ORDER[b.settlement.outcome]);

  const entries: string[] = [];
  for (const { settlement, market } of settled.slice(0, MAX_SHOUT_ENTRIES)) {
    const claim = await db.getClaim(market.claim_id);
    const claimer = claim ? await db.getUser(claim.claimer_user_id) : null;
    const moneyLine = await wager.settlementPayoutsLine(market.id, settlement.outcome);
    entries.push(
      entryLine(
        settlement.outcome,
        claim?.quoted_text ?? 'the call',
        claimer?.display_name ?? 'someone',
        moneyLine,
      ),
    );
  }

  const fixture = await db.getFixture(args.fixtureId);
  const header = fixture ? `🏆 FULL TIME: ${scoreline(fixture)}!` : '🏆 FULL TIME!';
  const lines = [header, '', ...entries];
  if (settled.length > MAX_SHOUT_ENTRIES) {
    lines.push('', `…and ${settled.length - MAX_SHOUT_ENTRIES} more settled on the night.`);
  }
  lines.push('', "That's the whistle. Next match, new calls.");
  return lines.join('\n');
}
