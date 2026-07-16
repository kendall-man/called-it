import { describe, expect, it } from 'vitest';
import type { Deps, MarketRow } from '../ports.js';
import { escrowMarketPositionsReady, registerEscrowMarketProvisioner } from './escrow-market-provisioning.js';

describe('escrow market card gate', () => {
  it('preserves legacy cards and requires the registered finalized provisioner in escrow mode', async () => {
    const errors: unknown[] = [];
    const legacy = { env: { WAGER_CUSTODY_MODE: 'legacy' }, log: { error() {} } } as unknown as Deps;
    await expect(escrowMarketPositionsReady(legacy, {} as MarketRow)).resolves.toBe(true);

    const escrow = {
      env: { WAGER_CUSTODY_MODE: 'escrow' },
      log: { error(event: string, value: unknown) { errors.push([event, value]); } },
    } as unknown as Deps;
    await expect(escrowMarketPositionsReady(escrow, { id: 'market' } as MarketRow)).resolves.toBe(false);
    registerEscrowMarketProvisioner(escrow, { async ensure() { return true; } });
    await expect(escrowMarketPositionsReady(escrow, { id: 'market' } as MarketRow)).resolves.toBe(true);
    expect(errors).toEqual([]);
  });

  it('holds a replay until its on-chain market is finalized', async () => {
    const waits: number[] = [];
    let attempts = 0;
    const escrow = {
      env: { WAGER_CUSTODY_MODE: 'escrow' },
      log: { error() {} },
    } as unknown as Deps;
    registerEscrowMarketProvisioner(escrow, {
      async ensure() {
        attempts += 1;
        return attempts === 3;
      },
    });

    await expect(escrowMarketPositionsReady(
      escrow,
      { id: 'replay-market', is_replay: true } as MarketRow,
      async (milliseconds) => { waits.push(milliseconds); },
    )).resolves.toBe(true);

    expect(attempts).toBe(3);
    expect(waits).toEqual([1_500, 1_500]);
  });

  it('does not block a live call while its market is queued', async () => {
    let attempts = 0;
    const escrow = {
      env: { WAGER_CUSTODY_MODE: 'escrow' },
      log: { error() {} },
    } as unknown as Deps;
    registerEscrowMarketProvisioner(escrow, {
      async ensure() {
        attempts += 1;
        return false;
      },
    });

    await expect(escrowMarketPositionsReady(
      escrow,
      { id: 'live-market', is_replay: false } as MarketRow,
      async () => { throw new Error('live calls must not wait'); },
    )).resolves.toBe(false);
    expect(attempts).toBe(1);
  });
});
