import type { SettlementOutcome } from '@calledit/market-engine';
import { describeTerms, formatMultiplier, receiptCardText } from '../bot/cards.js';
import type { Say } from '../bot/copy.js';
import { composeTelegramMessage } from '../bot/message-budget.js';
import type { GroupPointsService } from '../points/service.js';
import type { Deps, MarketRow } from '../ports.js';
import { receiptUrl } from '../pipeline/render.js';

type GroupPointsReceiptRequest = {
  readonly deps: Deps;
  readonly market: MarketRow;
  readonly outcome: SettlementOutcome;
  readonly voidReason: string | undefined;
  readonly say: Say;
};

export async function prepareGroupPointsReceipt(
  pointsService: GroupPointsService,
  request: GroupPointsReceiptRequest,
  loadPayoutsLine: () => Promise<string>,
): Promise<string> {
  const { deps, market, outcome, voidReason, say } = request;
  const pointsSummary = await pointsService.apply(market.id);
  const claim = await deps.db.getClaim(market.claim_id);
  const claimer = claim ? await deps.db.getUser(claim.claimer_user_id) : null;
  const claimerName = claimer?.display_name ?? 'the claimer';
  const payoutsLine = await loadPayoutsLine();
  const garnishKey =
    outcome === 'claim_won' ? 'settle_won' : outcome === 'claim_lost' ? 'settle_lost' : 'void_market';
  const garnish = await say(garnishKey, {
    claimer: claimerName,
    payouts: payoutsLine,
    reason: voidReason ?? 'the match got away from us',
    terms: describeTerms(market.spec),
    multiplier: formatMultiplier(market.quote_multiplier).replace('×', ''),
    url: receiptUrl(deps, market.id),
  });
  const points = pointsSummary.eligible && outcome !== 'void'
    ? {
        winnerCount: pointsSummary.winnerCount,
        missCount: pointsSummary.scoredCount - pointsSummary.winnerCount,
        winners: pointsSummary.winners,
        misses: pointsSummary.misses,
        leaderboard: pointsSummary.leaderboard,
      }
    : undefined;
  const receipt = receiptCardText({
    currency: market.currency === 'usdc' ? 'usdc' : 'sol',
    quotedText: claim?.quoted_text ?? '(original message unavailable)',
    claimerName,
    spec: market.spec,
    outcome,
    probability: market.quote_probability,
    provenance: market.price_provenance,
    payoutsLine,
    isReplay: market.is_replay,
    receiptUrl: receiptUrl(deps, market.id),
    ...(points === undefined ? {} : { points }),
  });

  return composeTelegramMessage({ body: receipt, garnish });
}
