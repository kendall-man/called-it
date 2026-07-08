/**
 * Composes chat cards from database rows (shared by the stake handlers and
 * the settler so a card edit always reflects persisted state).
 */

import type { Deps, MarketRow, PositionRow } from '../ports.js';
import { claimCardText, type SideTally } from '../bot/cards.js';

export function tally(positions: PositionRow[]): { back: SideTally; doubt: SideTally } {
  const back: SideTally = { count: 0, totalRep: 0 };
  const doubt: SideTally = { count: 0, totalRep: 0 };
  for (const position of positions) {
    if (position.state === 'void') continue;
    const side = position.side === 'back' ? back : doubt;
    side.count += 1;
    side.totalRep += position.stake;
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
  const { back, doubt } = tally(positions);
  // Footer exists only for sol markets with the wager module live; Rep cards
  // (and any card while the flag is off) render byte-identical to main.
  const footer = market.currency === 'sol' ? deps.wager?.cardFooter() : undefined;
  const text = claimCardText({
    quotedText: claim.quoted_text,
    claimerName: claimer?.display_name ?? 'the claimer',
    spec: market.spec,
    status: market.status,
    probability: market.quote_probability,
    multiplier: market.quote_multiplier,
    provenance: market.price_provenance,
    back,
    doubt,
    isReplay: market.is_replay,
    receiptUrl: receiptUrl(deps, market.id),
    tableUrl: tableUrl(deps, group.slug),
    ...(footer !== undefined ? { footer } : {}),
  });
  return { chatId: market.group_id, messageId: market.card_tg_message_id, text };
}
