import {
  deriveMarketPda,
  deriveUserPositionPda,
  type UserPositionAccount,
} from '@calledit/escrow-sdk';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { createProductionEscrowSettlementPositionPort } from './event-workflow-runtime.js';
import type { DecodedEscrowAccount } from './solana-accounts.js';

const PROGRAM_ID = 'HrKUo8Bue31kU9sobzQGK5qDxVxBu5nBLXP3aGeKCDFL';
const MARKET_ID = '123e4567-e89b-12d3-a456-426614174000';

function position(
  marketPda: string,
  ownerPubkey: string,
  settlementProcessed: boolean,
): UserPositionAccount {
  return {
    version: 1, bump: 1, market: marketPda, owner: ownerPubkey, side: 'back',
    activeAmount: 1n, pendingAmount: 0n, refundableAmount: 0n,
    settlementBaseEntitlement: settlementProcessed ? 1n : 0n,
    settlementProcessed, nextLotNonce: 1n, claimed: false,
    totalPaidAmount: 1n, createdSlot: 1n, updatedSlot: 2n,
  };
}

describe('production escrow settlement position port', () => {
  it('enumerates finalized aggregate positions and verifies each owner against chain state', async () => {
    const marketPda = deriveMarketPda(PROGRAM_ID, MARKET_ID).address;
    const owners = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];
    const accounts = new Map(owners.map((ownerPubkey, index) => {
      const address = deriveUserPositionPda(PROGRAM_ID, marketPda, ownerPubkey).address;
      const decoded: DecodedEscrowAccount<UserPositionAccount> = {
        address, ownerProgramId: PROGRAM_ID, lamports: 1n,
        value: position(marketPda, ownerPubkey, index === 1),
      };
      return [address, decoded] as const;
    }));
    const requested: URL[] = [];
    const port = createProductionEscrowSettlementPositionPort({
      supabaseUrl: 'https://example.supabase.co',
      serviceRoleKey: 'test-service-role',
      programId: PROGRAM_ID,
      accounts: { async position(address) { return accounts.get(address) ?? null; } },
      async fetch(input) {
        const url = new URL(input);
        requested.push(url);
        return {
          ok: true,
          async json() {
            return owners.map((ownerPubkey) => ({
              owner_pubkey: ownerPubkey,
              position_pda: deriveUserPositionPda(PROGRAM_ID, marketPda, ownerPubkey).address,
            }));
          },
        };
      },
    });

    await expect(port.positions({ marketId: MARKET_ID, marketPda })).resolves.toEqual([
      { ownerPubkey: owners[0], settlementProcessed: false },
      { ownerPubkey: owners[1], settlementProcessed: true },
    ]);
    expect(requested).toHaveLength(1);
    expect(requested[0]?.searchParams.get('commitment')).toBe('eq.finalized');
    expect(requested[0]?.searchParams.get('canonical')).toBe('eq.true');
  });

  it('rejects a projected position that does not match its canonical PDA', async () => {
    const marketPda = deriveMarketPda(PROGRAM_ID, MARKET_ID).address;
    const ownerPubkey = Keypair.generate().publicKey.toBase58();
    const port = createProductionEscrowSettlementPositionPort({
      supabaseUrl: 'https://example.supabase.co',
      serviceRoleKey: 'test-service-role',
      programId: PROGRAM_ID,
      accounts: { async position() { return null; } },
      async fetch() {
        return {
          ok: true,
          async json() { return [{ owner_pubkey: ownerPubkey, position_pda: 'wrong-pda' }]; },
        };
      },
    });

    await expect(port.positions({ marketId: MARKET_ID, marketPda }))
      .rejects.toThrow('escrow position chain identity mismatch');
  });
});
