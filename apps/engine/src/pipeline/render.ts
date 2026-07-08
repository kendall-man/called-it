/**
 * Composes chat cards from database rows (shared by the stake handlers and
 * the settler so a card edit always reflects persisted state).
 */

import type { Deps, MarketRow, PositionRow } from '../ports.js';
import { claimCardText, type SideTally } from '../bot/cards.js';
import { computePots } from '../wager/pot.js';

/** Card tallies over non-void positions (a fresh in-play tap shows at once). */
export function tally(positions: PositionRow[]): { back: SideTally; doubt: SideTally } {
  const back: SideTally = { count: 0, stakeLamports: 0n };
  const doubt: SideTally = { count: 0, stakeLamports: 0n };
  for (const position of positions) {
    if (position.state === 'void') continue;
    const side = position.side === 'back' ? back : doubt;
    side.count += 1;
    side.stakeLamports += BigInt(position.stake);
  }
  return { back, doubt };
}

export function receiptUrl(deps: Deps, marketId: string): string {
  return `${deps.env.WEB_BASE_URL}/r/${marketId}`;
}

export function tableUrl(deps: Deps, slug: string): string {
  return `${deps.env.WEB_BASE_URL}/g/${slug}`;
}

export interface ComposedCard {
  chatId: number;
  messageId: number | null;
  text: string;
}

export async function composeClaimCard(deps: Deps, market: MarketRow): Promise<ComposedCard | null> {
  const [claim, positions, group] = await Promise.all([
    deps.db.getClaim(market.claim_id),
    deps.db.positionsForMarket(market.id),
    deps.db.getGroup(market.group_id),
  ]);
  if (!claim || !group) return null;
  const claimer = await deps.db.getUser(claim.claimer_user_id);
  const nonVoid = positions.filter((p) => p.state !== 'void');
  const { back, doubt } = tally(nonVoid);
  const pots = computePots(nonVoid, market.quote_probability);
  const footer = deps.wager?.cardFooter();
  const text = claimCardText({
    quotedText: claim.quoted_text,
    claimerName: claimer?.display_name ?? 'the claimer',
    spec: market.spec,
    status: market.status,
    probability: market.quote_probability,
    provenance: market.price_provenance,
    back,
    doubt,
    matchedPct: pots.matchedPct,
    isReplay: market.is_replay,
    receiptUrl: receiptUrl(deps, market.id),
    ...(footer !== undefined ? { footer } : {}),
  });
  return { chatId: market.group_id, messageId: market.card_tg_message_id, text };
}
