import { describe, expect, it } from 'vitest';
import { WAGER_TUNABLES } from '../wager/constants.js';
import { makeFakeDeps } from '../wager/fakes.js';
import {
  createWagerModule,
} from '../wager/module.js';
import { createStarterOnlyWagerModule } from '../wager/starter-only-module.js';
import { starterOnlyWagerDbFromFake } from '../wager/starter-fake.test-support.js';
import type {
  StarterOnlyWagerModule,
  WagerCronRegistry,
} from '../wager/port.js';
import { registerWagerCronWorkers } from './index.js';

type FundedOnlyModuleCapability = Extract<
  keyof StarterOnlyWagerModule,
  'registerCommands' | 'registerFundedWorkers' | 'walletSummary'
>;

function collectingRegistry(): {
  readonly intervals: number[];
  readonly registry: WagerCronRegistry;
} {
  const intervals: number[] = [];
  return {
    intervals,
    registry: {
      every(intervalMs) {
        intervals.push(intervalMs);
      },
    },
  };
}

describe('wager runtime cron boundary', () => {
  it('registers only DB settlement recovery for starter-only', () => {
    // Given a DB-only starter module
    const { db, deps } = makeFakeDeps();
    const module = createStarterOnlyWagerModule({
      runtimeMode: 'starter_only',
      db: starterOnlyWagerDbFromFake(db),
      log: deps.log,
      starterGrantsEnabled: true,
      stakeAcceptanceEnabled: true,
    });
    const { intervals, registry } = collectingRegistry();
    const fundedCapabilitiesAreAbsent: [FundedOnlyModuleCapability] extends [never]
      ? true
      : false = true;

    // When cron workers are composed
    registerWagerCronWorkers(module, registry);

    // Then no custody worker cadence is registered
    expect(intervals).toEqual([WAGER_TUNABLES.SETTLEMENT_SWEEP_MS]);
    expect(fundedCapabilitiesAreAbsent).toBe(true);
    expect('walletSummary' in module).toBe(false);
    expect('registerCommands' in module).toBe(false);
    expect('registerFundedWorkers' in module).toBe(false);
  });

  it('adds custody workers only for the funded module kind', () => {
    // Given the funded module
    const { deps } = makeFakeDeps();
    const module = createWagerModule(deps);
    const { intervals, registry } = collectingRegistry();

    // When cron workers are composed
    registerWagerCronWorkers(module, registry);

    // Then settlement and all funded workers are scheduled
    expect(intervals.sort((left, right) => left - right)).toEqual(
      [
        WAGER_TUNABLES.SETTLEMENT_SWEEP_MS,
        WAGER_TUNABLES.DEPOSIT_POLL_MS,
        WAGER_TUNABLES.DEPOSIT_POLL_MS,
        WAGER_TUNABLES.OUTBOX_TICK_MS,
        WAGER_TUNABLES.SOLVENCY_POLL_MS,
      ].sort((left, right) => left - right),
    );
  });
});
