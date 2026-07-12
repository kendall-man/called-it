/**
 * Void an abandoned SOL market — a claim that got minted but never drew a
 * single bet. Records a 'void' settlement (which refunds every escrowed stake
 * through the wager module) but deliberately does NOT post a receipt: the
 * existing sweepUnpostedSettlements cron owns receipt posting, so leaving
 * posted_at null lets it post exactly once (no double-post race).
 *
 * Used by the claimer's "Not mine" decline (post-mint, zero bets) and the
 * kickoff sweep (non-replay markets whose fixture started with no positions).
 */

import type { Deps, MarketRow } from '../ports.js';

type VoidAbandonedMarketDeps = {
  readonly db: Pick<Deps['db'], 'updateMarketStatus' | 'insertSettlement'>;
  readonly wager: Pick<NonNullable<Deps['wager']>, 'applySettlement'> | null;
  readonly log: Pick<Deps['log'], 'info'>;
};

export async function voidAbandonedMarket(
  deps: VoidAbandonedMarketDeps,
  market: MarketRow,
): Promise<void> {
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
  deps.log.info('market_voided_abandoned', { marketId: market.id });
}

/** True when the market has no stake that could be at risk (safe to auto-void). */
export function hasNoActivePositions(
  positions: Array<{ state: 'pending' | 'active' | 'void' }>,
): boolean {
  return positions.every((position) => position.state === 'void');
}
