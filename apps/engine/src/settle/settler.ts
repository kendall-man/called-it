/**
 * Settlement loop: normalized feed events → idempotent persistence →
 * pure reduceMarket/checkDebounce → ledger postings, card updates, receipts.
 *
 * All settlement LOGIC lives in @calledit/market-engine; this class only
 * persists effects and talks to chat. Ledger idempotency keys
 * (stake:<pos-id> / payout:<market>:<user> / refund:<pos-id>) make every
 * path here crash-safe and re-runnable.
 *
 * Known residual: pendingSettlement debounce windows are held in memory
 * (markets table has no column for them). A crash inside a 90s window loses
 * the pending candidate; the next event or terminal phase re-derives it.
 */

import type {
  MarketEffect,
  MarketState,
  MatchEvent,
  Position,
  SettlementOutcome,
} from '@calledit/market-engine';
import { TUNABLES } from '@calledit/market-engine';
import type { Deps, MarketRow, PositionRow } from '../ports.js';
import type { Poster } from '../bot/poster.js';
import type { Say } from '../bot/copy.js';
import { describeTerms, formatMultiplier, receiptCardText } from '../bot/cards.js';
import { composeClaimCard, receiptUrl } from '../pipeline/render.js';
import { quoteSpec } from '../pipeline/claims.js';
import { stakeKeyboard } from '../bot/keyboards.js';
import { statKeyForSpec } from './statKeys.js';
import type { ProofWorker } from '../proofs/worker.js';

function toEnginePosition(row: PositionRow): Position {
  return {
    id: row.id,
    userId: String(row.user_id),
    side: row.side,
    stake: row.stake,
    lockedMultiplier: row.locked_multiplier,
    placedAtMs: row.placed_at_ms,
    state: row.state,
  };
}

/** Winning Rep per user (payout = stake × locked multiplier, aggregated). */
export function computeWinners(
  positions: PositionRow[],
  outcome: SettlementOutcome,
): Map<number, number> {
  const winners = new Map<number, number>();
  if (outcome === 'void') return winners;
  const winningSide = outcome === 'claim_won' ? 'back' : 'doubt';
  for (const position of positions) {
    if (position.state !== 'active' || position.side !== winningSide) continue;
    const amount = Math.round(position.stake * position.locked_multiplier);
    winners.set(position.user_id, (winners.get(position.user_id) ?? 0) + amount);
  }
  return winners;
}

export class Settler {
  private readonly states = new Map<string, MarketState>();

  constructor(
    private readonly deps: Deps,
    private readonly poster: Poster,
    private readonly say: Say,
    private readonly proofWorker: ProofWorker | null,
  ) {}

  /** Every normalized event flows through here exactly once per (fixture, seq). */
  async onEvent(event: MatchEvent): Promise<void> {
    const { inserted } = await this.deps.db.insertFeedEvent(event);
    if (!inserted) {
      this.deps.log.info('feed_event_duplicate', { fixtureId: event.fixtureId, seq: event.seq });
      return;
    }
    await this.deps.db.updateFixtureFromEvent(event);
    const markets = await this.deps.db.openMarketsForFixture(event.fixtureId);
    await this.narrateGoal(event, markets);
    for (const market of markets) {
      try {
        const state = await this.hydrate(market);
        const result = this.deps.engine.reduceMarket(state, event);
        this.states.set(market.id, result.state);
        await this.applyEffects(market, result.state, result.effects, event);
      } catch (err) {
        this.deps.log.error('reduce_failed', {
          marketId: market.id,
          seq: event.seq,
          error: String(err),
        });
      }
    }
  }

  /** Interval tick: settle pending candidates whose debounce window passed. */
  async tick(nowMs: number): Promise<void> {
    for (const [marketId, state] of [...this.states]) {
      if (!state.pendingSettlement) continue;
      const market = await this.deps.db.getMarket(marketId);
      if (!market || market.status === 'settled' || market.status === 'voided') {
        this.states.delete(marketId);
        continue;
      }
      try {
        const result = this.deps.engine.checkDebounce(state, nowMs);
        this.states.set(marketId, result.state);
        await this.applyEffects(market, result.state, result.effects, null);
      } catch (err) {
        this.deps.log.error('debounce_failed', { marketId, error: String(err) });
      }
    }
  }

  private async hydrate(row: MarketRow): Promise<MarketState> {
    const positions = (await this.deps.db.positionsForMarket(row.id)).map(toEnginePosition);
    const cached = this.states.get(row.id);
    if (cached) {
      cached.positions = positions;
      return cached;
    }
    const state: MarketState = {
      marketId: row.id,
      spec: row.spec,
      status: row.status,
      positions,
      pendingSettlement: null,
      createdAtMs: Date.parse(row.created_at),
    };
    this.states.set(row.id, state);
    return state;
  }

  private async applyEffects(
    market: MarketRow,
    state: MarketState,
    effects: MarketEffect[],
    event: MatchEvent | null,
  ): Promise<void> {
    for (const effect of effects) {
      this.deps.log.info('market_effect', { marketId: market.id, effect: effect.kind, seq: event?.seq });
      switch (effect.kind) {
        case 'freeze':
          await this.deps.db.updateMarketStatus(market.id, 'frozen');
          if (effect.reason === 'var') {
            await this.narrate(market, 'var_freeze', {});
          }
          await this.refreshCard(market.id);
          break;
        case 'unfreeze':
          await this.deps.db.updateMarketStatus(market.id, 'open');
          await this.narrate(market, 'calls_unlocked', {});
          await this.refreshCard(market.id);
          break;
        case 'settle':
          await this.settle(market, effect.outcome, effect.decidingSeq, effect.evidenceSeqs);
          break;
        case 'void':
          await this.settle(market, 'void', event?.seq ?? null, [], effect.reason);
          break;
        case 'void_positions':
          await this.voidPositions(market, effect.positionIds);
          break;
        case 'activate_positions':
          await this.deps.db.setPositionStates(effect.positionIds, 'active');
          await this.refreshCard(market.id);
          break;
        case 'activate_market': {
          await this.deps.db.updateMarketStatus(market.id, 'open');
          const line = await this.say('lineup_activated');
          this.poster.post(market.group_id, line);
          await this.refreshCard(market.id);
          break;
        }
        case 'reprice_hint':
          await this.reprice(market);
          break;
      }
    }
    // Persist any reducer-side status move not covered by an explicit effect.
    if (
      state.status !== market.status &&
      state.status !== 'settled' &&
      state.status !== 'voided'
    ) {
      await this.deps.db.updateMarketStatus(market.id, state.status);
    }
  }

  private async settle(
    market: MarketRow,
    outcome: SettlementOutcome,
    decidingSeq: number | null,
    evidenceSeqs: number[],
    voidReason?: string,
  ): Promise<void> {
    const tier = market.spec.trustTier;
    await this.deps.db.updateMarketStatus(market.id, outcome === 'void' ? 'voided' : 'settled');
    await this.deps.db.insertSettlement({
      market_id: market.id,
      outcome,
      deciding_seq: decidingSeq,
      evidence_seqs: evidenceSeqs,
      tier,
    });
    this.deps.log.info('settled', { marketId: market.id, outcome, decidingSeq, tier });

    const positions = await this.deps.db.positionsForMarket(market.id);

    // Refund still-pending taps (their anti-snipe window never cleared) and
    // everyone on a void.
    const refundIds: string[] = [];
    for (const position of positions) {
      if (position.state === 'void') continue;
      const refundable = outcome === 'void' || position.state === 'pending';
      if (!refundable) continue;
      await this.deps.db.postLedger({
        group_id: market.group_id,
        user_id: position.user_id,
        market_id: market.id,
        kind: 'refund',
        amount: position.stake,
        idempotency_key: `refund:${position.id}`,
      });
      if (position.state === 'pending') refundIds.push(position.id);
    }
    if (refundIds.length > 0) await this.deps.db.setPositionStates(refundIds, 'void');

    const winners = computeWinners(positions, outcome);
    for (const [userId, amount] of winners) {
      await this.deps.db.postLedger({
        group_id: market.group_id,
        user_id: userId,
        market_id: market.id,
        kind: 'payout',
        amount,
        idempotency_key: `payout:${market.id}:${userId}`,
      });
    }

    await this.postReceipt(market, outcome, winners, voidReason);

    if (tier === 'chain_proven' && outcome !== 'void' && this.proofWorker && decidingSeq !== null) {
      const statKey = statKeyForSpec(market.spec);
      if (statKey !== null) {
        this.proofWorker.enqueue({
          marketId: market.id,
          fixtureId: market.fixture_id,
          seq: decidingSeq,
          statKey,
          comparator: market.spec.comparator,
          threshold: market.spec.threshold,
        });
      }
    }
    this.states.delete(market.id);
  }

  async postReceipt(
    market: MarketRow,
    outcome: SettlementOutcome,
    winners: Map<number, number>,
    voidReason?: string,
  ): Promise<void> {
    const claim = await this.deps.db.getClaim(market.claim_id);
    const claimer = claim ? await this.deps.db.getUser(claim.claimer_user_id) : null;
    const claimerName = claimer?.display_name ?? 'the claimer';

    const payoutParts: string[] = [];
    for (const [userId, amount] of winners) {
      const user = await this.deps.db.getUser(userId);
      payoutParts.push(`${user?.display_name ?? 'A winner'} collects ${amount} Rep`);
    }
    const payoutsLine =
      outcome === 'void'
        ? 'All Rep returned.'
        : payoutParts.length > 0
          ? `${payoutParts.join(' · ')}.`
          : 'No Rep changed hands.';

    const totalPayout = [...winners.values()].reduce((sum, amount) => sum + amount, 0);
    const garnishKey =
      outcome === 'claim_won' ? 'settle_won' : outcome === 'claim_lost' ? 'settle_lost' : 'void_market';
    const garnish = await this.say(garnishKey, {
      claimer: claimerName,
      payouts: payoutsLine,
      reason: voidReason ?? 'the match got away from us',
      terms: describeTerms(market.spec),
      multiplier: formatMultiplier(market.quote_multiplier).replace('×', ''),
      payout: totalPayout,
      url: receiptUrl(this.deps, market.id),
    });

    const receipt = receiptCardText({
      quotedText: claim?.quoted_text ?? '(original message unavailable)',
      claimerName,
      spec: market.spec,
      outcome,
      probability: market.quote_probability,
      multiplier: market.quote_multiplier,
      provenance: market.price_provenance,
      payoutsLine,
      isReplay: market.is_replay,
      receiptUrl: receiptUrl(this.deps, market.id),
    });

    this.poster.post(market.group_id, `${garnish}\n\n${receipt}`, {
      onSent: async () => {
        await this.deps.db.markSettlementPosted(market.id);
      },
    });
    await this.refreshCard(market.id);
  }

  private async voidPositions(market: MarketRow, positionIds: string[]): Promise<void> {
    if (positionIds.length === 0) return;
    await this.deps.db.setPositionStates(positionIds, 'void');
    const positions = await this.deps.db.positionsForMarket(market.id);
    const affected = positions.filter((p) => positionIds.includes(p.id));
    const names: string[] = [];
    for (const position of affected) {
      await this.deps.db.postLedger({
        group_id: market.group_id,
        user_id: position.user_id,
        market_id: market.id,
        kind: 'refund',
        amount: position.stake,
        idempotency_key: `refund:${position.id}`,
      });
      const user = await this.deps.db.getUser(position.user_id);
      if (user && !names.includes(user.display_name)) names.push(user.display_name);
    }
    this.deps.log.info('delay_snipe_voided', { marketId: market.id, positionIds });
    const line = await this.say('after_the_moment', {
      names: names.join(', ') || 'Those taps',
    });
    this.poster.post(market.group_id, line);
    await this.refreshCard(market.id);
  }

  private async reprice(market: MarketRow): Promise<void> {
    const fresh = await this.deps.db.getMarket(market.id);
    if (!fresh || fresh.status !== 'open') return;
    const quote = await quoteSpec(this.deps, fresh.spec);
    if (!quote) return;
    const movePp = Math.abs(quote.probability - fresh.quote_probability) * 100;
    if (movePp < TUNABLES.REPRICE_TRIGGER_PP) return;
    await this.deps.db.setMarketQuote(market.id, {
      quote_probability: quote.probability,
      quote_multiplier: quote.multiplier,
      odds_message_id: quote.oddsMessageId,
      odds_ts: quote.oddsTsMs,
    });
    this.deps.log.info('repriced', { marketId: market.id, movePp });
    await this.refreshCard(market.id);
  }

  /** Re-render the claim card from persisted state (collapsed per tunables). */
  private async refreshCard(marketId: string): Promise<void> {
    const market = await this.deps.db.getMarket(marketId);
    if (!market || market.card_tg_message_id === null) return;
    const card = await composeClaimCard(this.deps, market);
    if (!card || card.messageId === null) return;
    const keyboard =
      market.status === 'open' || market.status === 'pending_lineup'
        ? stakeKeyboard(market.id)
        : undefined;
    this.poster.editCard(card.chatId, market.id, card.messageId, card.text, keyboard);
  }

  /** Scorer-named goal alert referencing the group's open calls (nudge mode only). */
  private async narrateGoal(event: MatchEvent, markets: MarketRow[]): Promise<void> {
    if (event.kind !== 'goal' || !event.confirmed || markets.length === 0) return;
    const byGroup = new Map<number, number>();
    for (const market of markets) {
      byGroup.set(market.group_id, (byGroup.get(market.group_id) ?? 0) + 1);
    }
    for (const [groupId, count] of byGroup) {
      const group = await this.deps.db.getGroup(groupId);
      if (!group || group.chattiness !== 'nudge') continue;
      const line = await this.say('goal_alert', {
        scorer: event.detail?.playerName ?? 'Unconfirmed scorer',
        minute: event.minute ?? '?',
        note: `${count} open call${count === 1 ? '' : 's'} in here feeling it.`,
      });
      this.poster.post(groupId, line);
    }
  }

  /** Narration lines respect chattiness (nudge mode only). */
  private async narrate(
    market: MarketRow,
    key: 'var_freeze' | 'calls_unlocked',
    vars: Record<string, string | number>,
  ): Promise<void> {
    const group = await this.deps.db.getGroup(market.group_id);
    if (!group || group.chattiness !== 'nudge') return;
    const line = await this.say(key, vars);
    this.poster.post(market.group_id, line);
  }
}
