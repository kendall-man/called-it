import { describe, expect, it } from 'vitest';
import type { Deps, MarketRow } from '../ports.js';
import type { Poster } from '../bot/poster.js';
import {
  CHAT_ID,
  stakeMarket,
} from '../bot/callbacks.stake.test-support.js';
import { recoverPausedEscrowCards } from './index.js';

const NOW = Date.parse('2026-07-18T10:00:00.000Z');

function makeHarness(options: {
  custodyMode?: 'legacy' | 'escrow';
  markets: readonly MarketRow[];
  readyMarketIds: readonly string[];
  stakesAvailable?: boolean;
}) {
  const edits: Array<{ marketId: string; messageId: number; hasKeyboard: boolean }> = [];
  const readinessChecks: string[] = [];
  const deps = {
    db: {
      async listGroups() {
        return [{
          id: CHAT_ID,
          title: 'G',
          slug: 'g',
          web_enabled: true,
          chattiness: 'nudge',
          is_admin: true,
        }];
      },
      async openMarketsForGroup() { return [...options.markets]; },
      async getMarket(id: string) {
        return options.markets.find((market) => market.id === id) ?? null;
      },
      async getClaim() {
        return {
          id: 'claim-1',
          group_id: CHAT_ID,
          claimer_user_id: 8001,
          tg_message_id: 1,
          quoted_text: 'Brazil win',
          status: 'confirmed',
          classifier_confidence: 1,
          parse: null,
          expires_at: null,
          created_at: new Date(NOW).toISOString(),
        };
      },
      async getGroup() {
        return {
          id: CHAT_ID,
          title: 'G',
          slug: 'g',
          web_enabled: true,
          chattiness: 'nudge',
          is_admin: true,
        };
      },
      async getUser(id: number) {
        return { id, display_name: `U${id}`, username: null };
      },
      async positionsForMarket() { return []; },
      async positionParticipantsForMarket() { return []; },
    },
    wager: options.stakesAvailable === undefined ? null : {
      async stakesAvailable() { return options.stakesAvailable; },
      cardFooter: () => 'Test SOL has no monetary value.',
    },
    env: {
      DEPLOYMENT_ENV: 'development',
      BETA_ALLOWED_GROUP_IDS: [CHAT_ID],
      WAGER_CUSTODY_MODE: options.custodyMode ?? 'escrow',
      SOLANA_NETWORK: 'devnet',
      WEB_BASE_URL: 'https://web.test',
    },
    log: { info() {}, warn() {}, error() {} },
    now: () => NOW,
  } as unknown as Deps;
  const poster = {
    post() {},
    editCard(_chatId: number, marketId: string, messageId: number, _text: string, keyboard?: unknown) {
      edits.push({ marketId, messageId, hasKeyboard: keyboard !== undefined });
    },
    stripKeyboard() {},
    react() {},
    chatAction() {},
  } as unknown as Poster;
  const recovery = {
    async ready(market: MarketRow) {
      readinessChecks.push(market.id);
      return options.readyMarketIds.includes(market.id);
    },
  };
  return { deps, poster, recovery, edits, readinessChecks };
}

const READY_ID = 'a1111111-1111-4111-8111-11111111aaaa';
const WAITING_ID = 'a1111111-1111-4111-8111-11111111bbbb';

describe('recoverPausedEscrowCards', () => {
  it('re-edits only ready open markets with the stake keyboard, once per market', async () => {
    const harness = makeHarness({
      markets: [
        stakeMarket({ id: READY_ID, card_tg_message_id: 900 }),
        stakeMarket({ id: WAITING_ID, card_tg_message_id: 901 }),
        stakeMarket({ id: 'no-card', card_tg_message_id: null }),
        stakeMarket({ id: 'replaying', card_tg_message_id: 902, is_replay: true }),
      ],
      readyMarketIds: [READY_ID],
    });
    const recovered = new Set<string>();

    await recoverPausedEscrowCards(harness.deps, harness.poster, harness.recovery, recovered);

    expect(harness.edits).toEqual([{ marketId: READY_ID, messageId: 900, hasKeyboard: true }]);
    // Replay markets and card-less markets never reach the provisioner.
    expect(harness.readinessChecks.sort()).toEqual([READY_ID, WAITING_ID].sort());
    expect(recovered.has(READY_ID)).toBe(true);

    // The next sweep skips the recovered market entirely (budget-respecting)
    // but keeps re-checking the one still waiting on provisioning.
    await recoverPausedEscrowCards(harness.deps, harness.poster, harness.recovery, recovered);
    expect(harness.edits).toHaveLength(1);
    expect(harness.readinessChecks.filter((id) => id === WAITING_ID)).toHaveLength(2);
  });

  it('recovers the waiting market on a later sweep once provisioning is ready', async () => {
    const readyMarketIds: string[] = [];
    const harness = makeHarness({
      markets: [stakeMarket({ id: WAITING_ID, card_tg_message_id: 901 })],
      readyMarketIds,
    });
    const recovered = new Set<string>();

    await recoverPausedEscrowCards(harness.deps, harness.poster, harness.recovery, recovered);
    expect(harness.edits).toHaveLength(0);

    readyMarketIds.push(WAITING_ID);
    await recoverPausedEscrowCards(harness.deps, harness.poster, harness.recovery, recovered);
    expect(harness.edits).toEqual([{ marketId: WAITING_ID, messageId: 901, hasKeyboard: true }]);
  });

  it('leaves the card paused while the stake desk itself is unavailable', async () => {
    const harness = makeHarness({
      markets: [stakeMarket({ id: READY_ID, card_tg_message_id: 900 })],
      readyMarketIds: [READY_ID],
      stakesAvailable: false,
    });

    await recoverPausedEscrowCards(harness.deps, harness.poster, harness.recovery, new Set());

    expect(harness.edits).toHaveLength(0);
  });

  it('does nothing outside escrow custody', async () => {
    const harness = makeHarness({
      custodyMode: 'legacy',
      markets: [stakeMarket({ id: READY_ID, card_tg_message_id: 900 })],
      readyMarketIds: [READY_ID],
    });

    await recoverPausedEscrowCards(harness.deps, harness.poster, harness.recovery, new Set());

    expect(harness.edits).toHaveLength(0);
    expect(harness.readinessChecks).toHaveLength(0);
  });
});
