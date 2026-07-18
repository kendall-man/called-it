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
import { isWagerAsset, TUNABLES } from '@calledit/market-engine';
import type { Deps, MarketRow, PositionRow } from '../ports.js';
import type { Poster } from '../bot/poster.js';
import type { Say } from '../bot/copy.js';
import { composeClaimCard, receiptUrl } from '../pipeline/render.js';
import { quoteSpec } from '../pipeline/claims.js';
import { marketStakeKeyboard } from '../bot/keyboards.js';
import { settlementPingText } from '../bot/stake-step-cards.js';
import { statKeyForSpec } from './statKeys.js';
import type { ProofWorker } from '../proofs/worker.js';
import type { SettlementJournal } from './durable.js';
import type { GroupPointsService } from '../points/service.js';
import { prepareGroupPointsReceipt } from './group-points-receipt.js';

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

/** Escrow markets are driven exclusively by finalized chain projections. */
function isLegacyCustody(market: MarketRow): boolean {
  return market.custody_mode !== 'escrow';
}

export class Settler {
  private readonly states = new Map<string, MarketState>();

  constructor(
    private readonly deps: Deps,
    private readonly poster: Poster,
    private readonly say: Say,
    private readonly points: GroupPointsService,
    private readonly proofWorker: ProofWorker | null,
    private readonly settlementJournal: SettlementJournal | null = null,
  ) {}

  /** Every normalized event flows through here exactly once per (fixture, seq). */
  async onEvent(event: MatchEvent): Promise<void> {
    const { inserted } = await this.deps.db.insertFeedEvent(event);
    if (!inserted) {
      this.deps.log.info('feed_event_duplicate', { fixtureId: event.fixtureId, seq: event.seq });
      return;
    }
    await this.deps.db.updateFixtureFromEvent(event);
    const markets = (await this.deps.db.openMarketsForFixture(event.fixtureId))
      .filter((market) => !market.is_replay && isLegacyCustody(market));
    await this.reduceMarkets(event, markets);
  }

  /**
   * Replays intentionally bypass the durable feed-event key because those
   * historical sequences already exist. Only test-marked markets in the
   * requesting group receive the event.
   */
  async onReplayEvent(
    groupId: number,
    event: MatchEvent,
    replayStartedAtMs: number = Number.NEGATIVE_INFINITY,
  ): Promise<void> {
    const markets = (await this.deps.db.openMarketsForFixture(event.fixtureId))
      .filter((market) =>
        market.is_replay &&
        isLegacyCustody(market) &&
        market.group_id === groupId &&
        Date.parse(market.created_at) >= replayStartedAtMs
      );
    await this.reduceMarkets(event, markets, true);
  }

  private async reduceMarkets(
    event: MatchEvent,
    markets: MarketRow[],
    strict: boolean = false,
  ): Promise<void> {
    await this.narrateGoal(event, markets);
    for (const market of markets) {
      try {
        const state = await this.hydrate(market);
        const result = this.deps.engine.reduceMarket(state, event);
        await this.applyEffects(market, result.state, result.effects, event);
        if (result.state.status === 'settled' || result.state.status === 'voided') {
          this.states.delete(market.id);
        } else {
          this.states.set(market.id, result.state);
        }
      } catch (error) {
        if (strict) this.states.delete(market.id);
        this.deps.log.error('reduce_failed', {
          marketId: market.id,
          seq: event.seq,
        });
        if (strict) throw error;
      }
    }
  }

  /** Interval tick: settle pending candidates whose debounce window passed. */
  async tick(nowMs: number): Promise<void> {
    for (const [marketId, state] of [...this.states]) {
      if (!state.pendingSettlement) continue;
      const market = await this.deps.db.getMarket(marketId);
      if (!market || !isLegacyCustody(market) || market.status === 'settled' || market.status === 'voided') {
        this.states.delete(marketId);
        continue;
      }
      try {
        const result = this.deps.engine.checkDebounce(state, nowMs);
        await this.applyEffects(market, result.state, result.effects, null);
        if (result.state.status === 'settled' || result.state.status === 'voided') {
          this.states.delete(marketId);
        } else {
          this.states.set(marketId, result.state);
        }
      } catch {
        this.deps.log.error('debounce_failed', { marketId });
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
      // Replay markets ride historical event timestamps; the reducer's
      // delay-snipe guard needs to know to judge taps by emission time.
      isReplay: row.is_replay,
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
    if (!isLegacyCustody(market)) {
      if (effects.length > 0) {
        this.deps.log.warn('legacy_effects_skipped_escrow_market', { marketId: market.id });
      }
      return;
    }
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
    if (!isLegacyCustody(market)) {
      this.deps.log.warn('legacy_settlement_skipped_escrow_market', { marketId: market.id });
      return;
    }
    const tier = market.spec.trustTier;
    if (this.settlementJournal) {
      // The Task 10 RPC writes the immutable terminal fact and settlement job
      // in one transaction, so a process death cannot leave one without the other.
      await this.settlementJournal.recordTerminal({
        marketId: market.id,
        outcome,
        decidingSeq,
        evidenceSeqs,
        tier,
      });
    } else {
      await this.deps.db.updateMarketStatus(market.id, outcome === 'void' ? 'voided' : 'settled');
      await this.deps.db.insertSettlement({
        market_id: market.id,
        outcome,
        deciding_seq: decidingSeq,
        evidence_seqs: evidenceSeqs,
        tier,
      });
    }
    this.deps.log.info('settled', { marketId: market.id, outcome, decidingSeq, tier });
    await reactToSettledClaim(this.deps, this.poster, market, outcome);

    // Money moves ONLY through the wager module for SOL/USDC markets. Its
    // applySettlement is idempotent (per-position/per-user keys plus the
    // wager_settlements_applied marker); if the module is somehow off, the
    // wager sweeper re-applies it once re-enabled.
    const fundedMainnetReplay = market.is_replay
      && this.deps.env?.SOLANA_NETWORK === 'mainnet-beta';
    if (!isWagerAsset(market.currency)) {
      // Legacy Rep markets use the shared Rep ledger effects from the reducer.
    } else if (market.is_replay && !fundedMainnetReplay) {
      // Devnet test matches remain ledger-free.
    } else if (this.deps.wager) {
      await this.deps.wager.applySettlement(
        market.id,
        fundedMainnetReplay ? { requireFullyBacked: true } : undefined,
      );
    } else {
      this.deps.log.warn('wager_settlement_deferred', { marketId: market.id, outcome });
    }
    await this.postReceipt(market, outcome, voidReason);

    if (
      this.settlementJournal === null
      && tier === 'chain_proven'
      && outcome !== 'void'
      && this.proofWorker
      && decidingSeq !== null
    ) {
      const statKey = statKeyForSpec(market.spec);
      if (statKey !== null) {
        await this.proofWorker.enqueue({
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
    voidReason?: string,
  ): Promise<void> {
    if (!isLegacyCustody(market)) {
      this.deps.log.warn('legacy_receipt_skipped_escrow_market', { marketId: market.id });
      return;
    }
    const receipt = await prepareGroupPointsReceipt(
      this.points,
      { deps: this.deps, market, outcome, voidReason, say: this.say },
      () => !isWagerAsset(market.currency)
        ? Promise.resolve('')
        : market.is_replay && this.deps.env?.SOLANA_NETWORK !== 'mainnet-beta'
          ? Promise.resolve('Test round - no starter position or real funds moved.')
          : this.solPayoutsLine(market.id, outcome),
    );

    const markPosted = async (): Promise<void> => {
      if (this.settlementJournal) {
        await this.settlementJournal.markPosted(market.id);
        return;
      }
      await this.deps.db.markSettlementPosted(market.id);
    };

    // Two-step lifecycle: the board is the FINAL edit of the same card message,
    // and one compact ping (reply to the card) carries the only notification —
    // card edits emit none. Net message count stays at one, as today. Flag off,
    // behaviour is unchanged: the full receipt posts and the card refreshes.
    if (this.deps.env?.STAKE_LADDER_ENABLED === true && market.card_tg_message_id !== null) {
      this.poster.editCard(
        market.group_id,
        market.id,
        market.card_tg_message_id,
        receipt,
        undefined,
        { urgent: true },
      );
      this.poster.post(market.group_id, settlementPingText(outcome, receiptUrl(this.deps, market.id)), {
        replyToMessageId: market.card_tg_message_id,
        onSent: markPosted,
      });
      return;
    }

    this.poster.post(market.group_id, receipt, { onSent: markPosted });
    await this.refreshCard(market.id);
  }

  private async solPayoutsLine(marketId: string, outcome: SettlementOutcome): Promise<string> {
    if (!this.deps.wager) return '';
    return this.deps.wager.settlementPayoutsLine(marketId, outcome);
  }

  private async voidPositions(market: MarketRow, positionIds: string[]): Promise<void> {
    if (positionIds.length === 0) return;
    await this.deps.db.setPositionStates(positionIds, 'void');
    const positions = await this.deps.db.positionsForMarket(market.id);
    const affected = positions.filter((p) => positionIds.includes(p.id));
    const names: string[] = [];
    for (const position of affected) {
      // Wager positions live in the asset ledger; their delay-snipe refunds are
      // reconciled by the wager module at settlement, never posted as Rep.
      if (!isWagerAsset(market.currency)) {
        await this.deps.db.postLedger({
          group_id: market.group_id,
          user_id: position.user_id,
          market_id: market.id,
          kind: 'refund',
          amount: position.stake,
          idempotency_key: `refund:${position.id}`,
        });
      }
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
    // A wager market's mint quote LOCKS the FOR↔AGAINST settlement ratio
    // (wager/pot.ts). Repricing it would settle the pot at a different ratio
    // than it was staked against — never touch a live sol quote.
    if (isWagerAsset(fresh.currency)) return;
    // Any pricing failure (transient, no line, unpriceable) just skips this
    // reprice tick — the card keeps its last good quote.
    const outcome = await quoteSpec(this.deps, fresh.spec);
    if (outcome.kind !== 'ok') return;
    const quote = outcome.quote;
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
        ? marketStakeKeyboard(this.deps, market)
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

/**
 * Zero-clutter "called it" ack on the original claim message when it lands.
 * Presentation only and best-effort — a missing claim row or reaction API
 * failure must never block or reverse settlement. Fires in every chattiness
 * mode because reactions are budget-free. Telegram's reaction set has no 🎯,
 * so the trophy stands in for a landed call. Shared by the legacy settler and
 * the escrow finalized-projection sink so both custody paths celebrate.
 */
export async function reactToSettledClaim(
  deps: Pick<Deps, 'db' | 'log'>,
  poster: Pick<Poster, 'react'>,
  market: Pick<MarketRow, 'id' | 'group_id' | 'claim_id'>,
  outcome: SettlementOutcome,
): Promise<void> {
  if (outcome !== 'claim_won') return;
  try {
    const claim = await deps.db.getClaim(market.claim_id);
    if (claim) poster.react(market.group_id, claim.tg_message_id, '🏆');
  } catch {
    deps.log.warn('settled_claim_reaction_skipped', { marketId: market.id });
  }
}
