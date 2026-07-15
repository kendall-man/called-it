import { describe, expect, it } from 'vitest';
import { createProductionEscrowPositionActivationScheduler } from './position-activation-runtime.js';

function response(value: unknown, ok = true) {
  return { ok, async json() { return value; } };
}

describe('production escrow position activation scheduler', () => {
  it('pages finalized pending lots and schedules deterministic activation inputs', async () => {
    const requests: URL[] = [];
    const scheduled: unknown[] = [];
    const pages = [
      [
        { owner_pubkey: 'owner-a', lot_nonce: '0', event_epoch: '3' },
        { owner_pubkey: 'owner-b', lot_nonce: '4', event_epoch: '3' },
      ],
      [],
    ];
    const scheduler = createProductionEscrowPositionActivationScheduler({
      supabaseUrl: 'https://project.supabase.co', serviceRoleKey: 'service-role', pageSize: 2,
      activation: {
        async schedule(input) {
          scheduled.push(input);
          return { kind: 'enqueued', created: true, jobId: 'job' } as const;
        },
      },
      async fetch(input) {
        requests.push(new URL(input));
        return response(pages.shift() ?? []);
      },
    });

    await expect(scheduler.schedulePending({ marketId: 'market-id', marketPda: 'market-pda' }))
      .resolves.toEqual({ attempted: 2, enqueued: 2, skipped: 0 });
    expect(scheduled).toEqual([
      { marketPda: 'market-pda', owner: 'owner-a', lotNonce: 0n, expectedEventEpoch: 3n },
      { marketPda: 'market-pda', owner: 'owner-b', lotNonce: 4n, expectedEventEpoch: 3n },
    ]);
    expect(Object.fromEntries(requests[0]!.searchParams)).toMatchObject({
      market_id: 'eq.market-id', commitment: 'eq.finalized', canonical: 'eq.true',
      state: 'eq.pending', order: 'owner_pubkey.asc,lot_nonce.asc', limit: '2', offset: '0',
    });
    expect(requests[1]!.searchParams.get('offset')).toBe('2');
  });

  it('does not let terminal or invalidated pending projections block cleanup', async () => {
    const codes = ['market_unavailable', 'stale_epoch', 'lot_invalidated'] as const;
    let index = 0;
    const scheduler = createProductionEscrowPositionActivationScheduler({
      supabaseUrl: 'https://project.supabase.co', serviceRoleKey: 'service-role',
      activation: {
        async schedule() {
          const { EscrowPositionActivationError } = await import('./position-activation-service.js');
          throw new EscrowPositionActivationError(codes[index++]!);
        },
      },
      fetch: async () => response(codes.map((_code, lot) => ({
        owner_pubkey: `owner-${lot}`, lot_nonce: String(lot), event_epoch: '2',
      }))),
    });

    await expect(scheduler.schedulePending({ marketId: 'market', marketPda: 'pda' })).resolves.toEqual({
      attempted: 3, enqueued: 0, skipped: 3,
    });
  });

  it('fails closed on stale projection data, unavailable pages, and readiness blocks', async () => {
    const malformed = createProductionEscrowPositionActivationScheduler({
      supabaseUrl: 'https://project.supabase.co', serviceRoleKey: 'service-role',
      activation: { schedule: async () => ({ kind: 'already_active' as const }) },
      fetch: async () => response([{ owner_pubkey: 'owner', lot_nonce: '-1', event_epoch: '2' }]),
    });
    await expect(malformed.schedulePending({ marketId: 'market', marketPda: 'pda' })).rejects.toThrow(
      'invalid pending escrow lot projection',
    );

    const unavailable = createProductionEscrowPositionActivationScheduler({
      supabaseUrl: 'https://project.supabase.co', serviceRoleKey: 'service-role',
      activation: { schedule: async () => ({ kind: 'already_active' as const }) },
      fetch: async () => response([], false),
    });
    await expect(unavailable.schedulePending({ marketId: 'market', marketPda: 'pda' })).rejects.toThrow(
      'pending escrow lots unavailable',
    );

    const blocked = createProductionEscrowPositionActivationScheduler({
      supabaseUrl: 'https://project.supabase.co', serviceRoleKey: 'service-role',
      activation: { schedule: async () => ({ kind: 'blocked' as const, reasons: ['rpc_unavailable'] }) },
      fetch: async () => response([{ owner_pubkey: 'owner', lot_nonce: '0', event_epoch: '2' }]),
    });
    await expect(blocked.schedulePending({ marketId: 'market', marketPda: 'pda' })).rejects.toThrow(
      'escrow position activation blocked',
    );
  });
});
