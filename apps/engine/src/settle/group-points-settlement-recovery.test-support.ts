import type { MatchEvent } from '@calledit/market-engine';
import type { EngineDb, SettlementRow } from '../ports.js';
import type { WagerModule } from '../wager/module.js';
import { sweepUnpostedSettlements } from '../cron/index.js';
import {
  GROUP_ID,
  MARKET_ID,
  type SettlementHarness,
} from './group-points-settlement.test-support.js';

export const FINAL_EVENT: MatchEvent = {
  kind: 'phase_change', fixtureId: 600, seq: 61,
  tsMs: Date.parse('2026-07-12T11:59:59.000Z'),
  receivedAtMs: Date.parse('2026-07-12T11:59:59.100Z'),
  confirmed: true, phase: 'F', minute: 90,
  score: {
    p1: { goals: 1, yellowCards: 0, redCards: 0, corners: 0 },
    p2: { goals: 0, yellowCards: 0, redCards: 0, corners: 0 },
    p1Goals90: 1, p2Goals90: 0,
  },
};

export function testWager(
  timeline: string[],
  payoutsLine = 'Test SOL outcome finalized.',
): WagerModule {
  return {
    kind: 'funded',
    currencyForMint: async () => 'sol',
    stakesAvailable: async () => true,
    handleStakeTap: async () => ({ reply: '', placed: false }),
    applySettlement: async () => { timeline.push('wager_apply'); },
    settlementPayoutsLine: async () => {
      timeline.push('sol_payouts');
      return payoutsLine;
    },
    cardFooter: () => '',
    presetLabels: () => ['0.01 SOL', '0.05 SOL', '0.1 SOL'],
    presetLamports: () => null,
    walletSummary: async () => ({ balanceLamports: 0n, lockedLamports: 0n, pubkey: null }),
    prepareStakeConfirmation: async () => ({ ok: false, reply: 'Unavailable' }),
    getStakeConfirmation: async () => null,
    confirmStakeConfirmation: async () => ({ reply: 'Unavailable', placed: false }),
    cancelStakeConfirmation: async () => false,
    registerCommands: () => undefined,
    registerSettlementRecovery: () => undefined,
    registerFundedWorkers: () => undefined,
  };
}

type PointsDb = Pick<
  EngineDb,
  'applyGroupPoints' | 'pointResultsForMarket' | 'leaderboard'
>;
type PointEvent = Awaited<ReturnType<PointsDb['pointResultsForMarket']>>[number];
type PlayerStats = Awaited<ReturnType<PointsDb['leaderboard']>>[number];

export interface OneSidedState {
  refundApplications: number;
  pointApplications: number;
  refunds: Array<{
    readonly marketId: string;
    readonly userId: number;
    readonly lamports: number;
  }>;
  pointEvents: PointEvent[];
  stats: PlayerStats[];
}

export function createOneSidedScenario(): {
  readonly state: OneSidedState;
  readonly wager: (timeline: string[]) => WagerModule;
  readonly pointsDb: Partial<PointsDb>;
} {
  const state: OneSidedState = {
    refundApplications: 0,
    pointApplications: 0,
    refunds: [],
    pointEvents: [],
    stats: [],
  };
  const wager = (timeline: string[]): WagerModule => ({
    ...testWager(timeline),
    applySettlement: async (marketId) => {
      timeline.push('wager_apply');
      state.refundApplications += 1;
      if (state.refunds.length === 0) {
        state.refunds.push({ marketId, userId: 6001, lamports: 10_000_000 });
      }
    },
    settlementPayoutsLine: async () => {
      timeline.push('sol_payouts');
      const count = state.refunds.length;
      return `${count} unmatched test SOL stake${count === 1 ? '' : 's'} returned.`;
    },
  });
  const pointsDb: Partial<PointsDb> = {
    applyGroupPoints: async () => {
      state.pointApplications += 1;
      if (state.refunds.length !== 1) return { ok: false, code: 'settlement_missing' };
      const duplicate = state.pointEvents.length > 0;
      if (!duplicate) {
        state.pointEvents.push({
          group_id: GROUP_ID, market_id: MARKET_ID, user_id: 6001, side: 'back',
          result: 'won', points_delta: 10, display_name: 'Alice', username: 'alice_calls',
        });
        state.stats.push({
          group_id: GROUP_ID, user_id: 6001, points: 10, wins: 1, losses: 0,
          accuracy: 1, current_streak: 1, best_streak: 1,
          display_name: 'Alice', username: 'alice_calls',
        });
      }
      return {
        ok: true, eligible: true, duplicate, reason: null,
        group_id: GROUP_ID, scored_count: 1, winner_count: 1,
      };
    },
    pointResultsForMarket: async () => [...state.pointEvents],
    leaderboard: async () => [...state.stats],
  };
  return { state, wager, pointsDb };
}

type SettlementInput = Parameters<EngineDb['insertSettlement']>[0];

export interface PersistedSweeper {
  readonly inFlight: Map<string, number>;
  queryCount(): number;
  postedCount(): number;
  persisted(): SettlementRow | null;
  sweep(): Promise<void>;
}

export function installPersistedSweeper(harness: SettlementHarness): PersistedSweeper {
  let settlement: SettlementRow | null = null;
  let queries = 0;
  let posts = 0;
  const inFlight = new Map<string, number>();
  const nowMs = FINAL_EVENT.receivedAtMs + 120_000;
  harness.deps.now = () => nowMs;
  Object.assign(harness.deps.db, {
    insertSettlement: async (input: SettlementInput) => {
      settlement = {
        ...input,
        posted_at: null,
        settled_at: new Date(nowMs).toISOString(),
      };
    },
    unpostedSettlements: async () => {
      queries += 1;
      const current = settlement;
      return current !== null && current.posted_at === null ? [current] : [];
    },
    markSettlementPosted: async (marketId: string) => {
      if (settlement === null || settlement.market_id !== marketId) {
        throw new TypeError('Persisted settlement is missing');
      }
      posts += 1;
      settlement = { ...settlement, posted_at: new Date(nowMs).toISOString() };
    },
  });
  return {
    inFlight,
    queryCount: () => queries,
    postedCount: () => posts,
    persisted: () => settlement,
    sweep: () => sweepUnpostedSettlements(harness.deps, harness.settler, inFlight),
  };
}
