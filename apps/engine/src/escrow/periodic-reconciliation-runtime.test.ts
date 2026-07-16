import { describe, expect, it } from 'vitest';
import { createProductionEscrowReconciliationLinkPort } from './periodic-reconciliation-runtime.js';

const DEPLOYMENT = {
  cluster: 'devnet',
  genesisHash: 'devnet-genesis',
  programId: 'program-id',
  custodyVersion: 1,
} as const;

function response(value: unknown, ok = true) {
  return { ok, async json() { return value; } };
}

describe('production periodic escrow reconciliation links', () => {
  it('queries an exact finalized deployment page with a deterministic cursor', async () => {
    const requests: URL[] = [];
    const source = createProductionEscrowReconciliationLinkPort({
      supabaseUrl: 'https://project.supabase.co',
      serviceRoleKey: 'service-role',
      deployment: DEPLOYMENT,
      async fetch(input) {
        requests.push(new URL(input));
        return response([
          { market_id: 'b', custody_mode: 'escrow', market_pda: 'market-b', vault_pda: 'vault-b', asset: 'sol' },
          { market_id: 'c', custody_mode: 'escrow', market_pda: 'market-c', vault_pda: 'vault-c', asset: 'usdc' },
        ]);
      },
    });

    await expect(source.listReconciliationLinks({ cursor: 'a', limit: 2 })).resolves.toEqual({
      links: [
        { marketId: 'b', custodyMode: 'escrow', marketPda: 'market-b', vaultPda: 'vault-b', asset: 'sol' },
        { marketId: 'c', custodyMode: 'escrow', marketPda: 'market-c', vaultPda: 'vault-c', asset: 'usdc' },
      ],
      nextCursor: 'c',
    });
    const query = requests[0]!.searchParams;
    expect(Object.fromEntries(query)).toMatchObject({
      custody_mode: 'eq.escrow', custody_version: 'eq.1', cluster: 'eq.devnet',
      genesis_hash: 'eq.devnet-genesis', program_id: 'eq.program-id',
      commitment: 'eq.finalized', canonical: 'eq.true', projection_stale: 'eq.false',
      chain_state: 'neq.closed', market_id: 'gt.a', order: 'market_id.asc', limit: '2',
    });
  });

  it('fails closed on malformed rows, transport failure, and unsafe limits', async () => {
    const malformed = createProductionEscrowReconciliationLinkPort({
      supabaseUrl: 'https://project.supabase.co', serviceRoleKey: 'service-role',
      deployment: DEPLOYMENT, fetch: async () => response([{ market_id: 'a' }]),
    });
    await expect(malformed.listReconciliationLinks({ cursor: null, limit: 1 })).rejects.toThrow(
      'invalid escrow reconciliation link projection',
    );

    const unavailable = createProductionEscrowReconciliationLinkPort({
      supabaseUrl: 'https://project.supabase.co', serviceRoleKey: 'service-role',
      deployment: DEPLOYMENT, fetch: async () => response([], false),
    });
    await expect(unavailable.listReconciliationLinks({ cursor: null, limit: 1 })).rejects.toThrow(
      'escrow reconciliation links unavailable',
    );
    await expect(unavailable.listReconciliationLinks({ cursor: null, limit: 1_001 })).rejects.toThrow(
      'invalid escrow reconciliation page limit',
    );
  });
});
