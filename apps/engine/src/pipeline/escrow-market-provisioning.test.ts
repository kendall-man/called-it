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
});
