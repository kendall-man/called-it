import { describe, expect, it } from 'vitest';
import { BASE_ENV } from './env.test-fixtures.js';
import { loadEnv } from './env.js';
import type { Logger } from './log.js';
import { TelegramFlowDb } from './points/telegram-points-flow-db.test-support.js';
import { makeFakeDeps } from './wager/fakes.js';
import { starterOnlyWagerDbFromFake } from './wager/starter-fake.test-support.js';
import { createProductionWagerRuntime } from './wiring-wager-runtime.js';

const ALLOWED_GROUP_ID = -100_123;
const DISALLOWED_GROUP_IDS = [-100_456, -100_789] as const;
const ALLOWED_MARKET_ID = 'allowed-market';
const DISALLOWED_PAYOUT_MARKET_ID = 'disallowed-payout-market';
const DISALLOWED_REFUND_MARKET_ID = 'disallowed-refund-market';

const TEST_LOG: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => TEST_LOG,
};

describe('starter-only settlement recovery runtime', () => {
  it('applies and retries only markets owned by production allowed groups', async () => {
    // Given one allowed and two disallowed settled markets behind the starter facade
    const env = loadEnv({
      ...BASE_ENV,
      DEPLOYMENT_ENV: 'production',
      TELEGRAM_INGRESS: 'poll',
      WAGER_RUNTIME_MODE: 'starter_only',
      WAGER_MODE_ENABLED: 'true',
      BETA_ALLOWED_GROUP_IDS: String(ALLOWED_GROUP_ID),
      GLM_BASE_URL: 'https://api.z.ai/api/anthropic',
      SOLANA_RPC_URL: 'https://api.devnet.solana.com',
      WEB_BASE_URL: 'https://web.example.test',
      WALLET_LINK_DOMAIN: 'web.example.test',
      STARTER_GRANTS_ENABLED: 'true',
      STAKE_ACCEPTANCE_ENABLED: 'true',
      WALLET_MINIAPP_ENABLED: 'false',
      TREASURY_COVERAGE_ENFORCED: 'false',
    });
    const { db } = makeFakeDeps();
    const groupByMarket = new Map<string, number>([
      [ALLOWED_MARKET_ID, ALLOWED_GROUP_ID],
      [DISALLOWED_PAYOUT_MARKET_ID, DISALLOWED_GROUP_IDS[0]],
      [DISALLOWED_REFUND_MARKET_ID, DISALLOWED_GROUP_IDS[1]],
    ]);
    db.settlements.set(ALLOWED_MARKET_ID, 'claim_won');
    db.settlements.set(DISALLOWED_PAYOUT_MARKET_ID, 'claim_won');
    db.settlements.set(DISALLOWED_REFUND_MARKET_ID, 'void');
    for (const marketId of groupByMarket.keys()) db.seedMarketProbability(marketId, 0.5);
    db.seedPosition({ market_id: ALLOWED_MARKET_ID, user_id: 1, side: 'back' });
    db.seedPosition({ market_id: DISALLOWED_PAYOUT_MARKET_ID, user_id: 2, side: 'back' });
    db.seedPosition({
      market_id: DISALLOWED_REFUND_MARKET_ID,
      user_id: 3,
      side: 'doubt',
      state: 'pending',
    });
    const selectedScopes: Array<readonly number[] | undefined> = [];
    const recoverySelections: string[][] = [];
    const markerReads: string[] = [];
    const outcomeReads: string[] = [];
    const probabilityReads: string[] = [];
    const positionReads: string[] = [];
    const positionMutationMarketIds: string[] = [];
    const ledgerMutationMarketIds: string[] = [];
    const markerWrites: string[] = [];
    let markerWriteFailuresRemaining = 1;
    const engineDb = Object.assign(new TelegramFlowDb(() => 0), {
      async positionsForMarket(marketId: string) {
        positionReads.push(marketId);
        return db.positionsForMarket(marketId);
      },
      async setPositionStates(ids: string[], state: 'pending' | 'active' | 'void') {
        for (const position of db.positions) {
          if (ids.includes(position.id)) positionMutationMarketIds.push(position.market_id);
        }
        await db.setPositionStates(ids, state);
      },
    });

    const module = await createProductionWagerRuntime(
      { env, log: TEST_LOG, engineDb },
      {
        loadStarterOnlyDbFactory: () => (
          _url: string,
          _serviceRoleKey: string,
          allowedGroupIds: readonly number[] | undefined,
        ) => {
          selectedScopes.push(allowedGroupIds);
          const base = starterOnlyWagerDbFromFake(db);
          return {
            ...base,
            async settledSolMarketsMissingApplied() {
              const marketIds = await base.settledSolMarketsMissingApplied();
              const selected = allowedGroupIds === undefined
                ? marketIds
                : marketIds.filter((marketId) => {
                    const groupId = groupByMarket.get(marketId);
                    return groupId !== undefined && allowedGroupIds.includes(groupId);
                  });
              recoverySelections.push([...selected]);
              return selected;
            },
            async hasSettlementApplied(marketId) {
              markerReads.push(marketId);
              return base.hasSettlementApplied(marketId);
            },
            async getSettlementOutcome(marketId) {
              outcomeReads.push(marketId);
              return base.getSettlementOutcome(marketId);
            },
            async getMarketProbability(marketId) {
              probabilityReads.push(marketId);
              return base.getMarketProbability(marketId);
            },
            async postWagerLedger(entry) {
              if (entry.market_id !== null) ledgerMutationMarketIds.push(entry.market_id);
              return base.postWagerLedger(entry);
            },
            async insertSettlementApplied(marketId) {
              markerWrites.push(marketId);
              if (markerWriteFailuresRemaining > 0) {
                markerWriteFailuresRemaining -= 1;
                throw new TypeError('simulated settlement marker write failure');
              }
              await base.insertSettlementApplied(marketId);
            },
          };
        },
        loadFundedDbFactory: () => {
          throw new TypeError('funded DB factory reached from starter-only mode');
        },
        loadFundedSolanaRuntime: () => {
          throw new TypeError('funded chain factory reached from starter-only mode');
        },
      },
    );
    if (module === null) throw new TypeError('starter-only wager module was not constructed');
    const recoveryTasks: Array<() => void | Promise<void>> = [];
    module.registerSettlementRecovery({
      every(_intervalMs, task) {
        recoveryTasks.push(task);
      },
    });
    const recoveryTask = recoveryTasks[0];
    if (recoveryTask === undefined) throw new TypeError('settlement recovery was not registered');

    // When production recovery retries after the allowed marker write fails
    await recoveryTask();
    await recoveryTask();
    await recoveryTask();

    // Then only the allowed market is read and mutated, exactly once
    expect({
      selectedScopes,
      recoverySelections,
      markerReads,
      outcomeReads,
      probabilityReads,
      positionReads,
      positionMutationMarketIds,
      ledgerMutationMarketIds,
      markerWrites,
      appliedMarketIds: [...db.applied],
      settlementLedgerMarketIds: db.ledger
        .filter((entry) => entry.kind === 'payout' || entry.kind === 'refund')
        .map((entry) => entry.market_id),
    }).toEqual({
      selectedScopes: [[ALLOWED_GROUP_ID]],
      recoverySelections: [[ALLOWED_MARKET_ID], [ALLOWED_MARKET_ID], []],
      markerReads: [ALLOWED_MARKET_ID, ALLOWED_MARKET_ID],
      outcomeReads: [ALLOWED_MARKET_ID, ALLOWED_MARKET_ID],
      probabilityReads: [ALLOWED_MARKET_ID, ALLOWED_MARKET_ID],
      positionReads: [ALLOWED_MARKET_ID, ALLOWED_MARKET_ID],
      positionMutationMarketIds: [],
      ledgerMutationMarketIds: [ALLOWED_MARKET_ID, ALLOWED_MARKET_ID],
      markerWrites: [ALLOWED_MARKET_ID, ALLOWED_MARKET_ID],
      appliedMarketIds: [ALLOWED_MARKET_ID],
      settlementLedgerMarketIds: [ALLOWED_MARKET_ID],
    });
  });

  it('keeps development starter recovery explicitly unscoped', async () => {
    // Given development starter mode with a configured beta allowlist
    const env = loadEnv({
      ...BASE_ENV,
      WAGER_RUNTIME_MODE: 'starter_only',
      BETA_ALLOWED_GROUP_IDS: String(ALLOWED_GROUP_ID),
      WEB_BASE_URL: 'https://web.example.test',
      WALLET_LINK_DOMAIN: 'web.example.test',
      STARTER_GRANTS_ENABLED: 'true',
      STAKE_ACCEPTANCE_ENABLED: 'true',
    });
    const { db } = makeFakeDeps();
    const selectedScopes: Array<readonly number[] | undefined> = [];

    // When the development starter facade is constructed
    await createProductionWagerRuntime(
      { env, log: TEST_LOG, engineDb: new TelegramFlowDb(() => 0) },
      {
        loadStarterOnlyDbFactory: () => (
          _url: string,
          _serviceRoleKey: string,
          allowedGroupIds: readonly number[] | undefined,
        ) => {
          selectedScopes.push(allowedGroupIds);
          return starterOnlyWagerDbFromFake(db);
        },
        loadFundedDbFactory: () => {
          throw new TypeError('funded DB factory reached from starter-only mode');
        },
        loadFundedSolanaRuntime: () => {
          throw new TypeError('funded chain factory reached from starter-only mode');
        },
      },
    );

    // Then local compatibility is an explicit all-groups scope
    expect(selectedScopes).toEqual([undefined]);
  });
});
