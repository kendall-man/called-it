/**
 * Call off a SOL market: records a 'void' settlement, which refunds every
 * escrowed stake through the wager module (idempotently, via the single
 * money-movement path). Deliberately does NOT post a receipt: the existing
 * sweepUnpostedSettlements cron owns receipt posting, so leaving posted_at
 * null lets it post exactly once (no double-post race).
 *
 * Callers: the claimer's "Not mine" decline (post-mint, zero bets), the
 * kickoff sweep (non-replay markets whose fixture started with no positions),
 * and the admin /settle clear-decks path (in-flight markets WITH stakes, all
 * refunded in full).
 */

import type { Deps, MarketRow } from '../ports.js';

export async function voidAbandonedMarket(deps: Deps, market: MarketRow): Promise<void> {
  await deps.db.updateMarketStatus(market.id, 'voided');
  await deps.db.insertSettlement({
    market_id: market.id,
    outcome: 'void',
    deciding_seq: null,
    evidence_seqs: [],
    tier: market.spec.trustTier,
  });
  // Refund any escrowed stakes (there should be none on an abandoned market,
  // but applySettlement is the single money-movement path and is idempotent).
  if (market.currency === 'sol' && deps.wager) {
    await deps.wager.applySettlement(market.id);
  }
  deps.log.info('market_voided_abandoned', { marketId: market.id, groupId: market.group_id });
}

/** True when the market has no stake that could be at risk (safe to auto-void). */
export function hasNoActivePositions(
  positions: Array<{ state: 'pending' | 'active' | 'void' }>,
): boolean {
  return positions.every((position) => position.state === 'void');
}
