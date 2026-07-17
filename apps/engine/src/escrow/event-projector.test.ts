import type { EscrowProgramEvent } from '@calledit/escrow-sdk';
import { describe, expect, it } from 'vitest';
import { SolanaEscrowEventProjector } from './event-projector.js';

const PROGRAM_ID = 'HrKUo8Bue31kU9sobzQGK5qDxVxBu5nBLXP3aGeKCDFL';
const MARKET_ID = '123e4567-e89b-12d3-a456-426614174000';
const MARKET_PDA = 'market-pda';

function projector(chainState: 'settled' | 'voided') {
  let accountReads = 0;
  const value = new SolanaEscrowEventProjector(
    {
      async market() { accountReads += 1; return null; },
      async position() { accountReads += 1; return null; },
    },
    {
      async getMarketLink() {
        return {
          ok: true as const, found: true as const, marketId: MARKET_ID,
          custodyMode: 'escrow' as const, custodyVersion: 1, cluster: 'devnet' as const,
          genesisHash: 'devnet-genesis', programId: PROGRAM_ID, marketPda: MARKET_PDA,
          vaultPda: 'vault-pda', asset: 'usdc' as const, mintPubkey: 'mint-pubkey',
          documentHashHex: 'ab'.repeat(32), oracleEpoch: 7n, eventEpoch: 3n, ratioMilli: 1_500n,
          chainState, commitment: 'finalized' as const, projectionStale: false,
        };
      },
    },
    {
      cluster: 'devnet', genesisHash: 'devnet-genesis', programId: PROGRAM_ID,
      canonicalUsdcMint: 'mint-pubkey', custodyVersion: 1,
    },
  );
  return { value, accountReads: () => accountReads };
}

const context = { signature: 'signature-a', instructionIndex: 0, slot: 42n };

describe('Wave 3 escrow event projection', () => {
  it('ignores child events for markets owned by another public-cluster deployment', async () => {
    const value = new SolanaEscrowEventProjector(
      {
        async market() { throw new Error('must not read an untracked market'); },
        async position() { throw new Error('must not read an untracked position'); },
      },
      {
        async getMarketLink() { return { ok: true as const, found: false as const }; },
      },
      {
        cluster: 'devnet', genesisHash: 'devnet-genesis', programId: PROGRAM_ID,
        canonicalUsdcMint: 'mint-pubkey', custodyVersion: 1,
      },
    );
    const event: EscrowProgramEvent = {
      kind: 'PositionPlaced', market: 'foreign-market', position: 'foreign-position', lot: 'foreign-lot',
      owner: 'foreign-owner', nonce: 0n, side: 'back', amount: 1n, asset: 'sol',
      pending: false, eventEpoch: 1n, activationAfter: 0n,
      clientIntentHash: new Uint8Array(32),
    };

    await expect(value.project(event, context)).resolves.toBeNull();
  });

  it.each([
    ['settled', 'payout'],
    ['voided', 'refund'],
  ] as const)('uses the exact claimed destination for a %s market', async (chainState, claimKind) => {
    const fixture = projector(chainState);
    const event: EscrowProgramEvent = {
      kind: 'PositionClaimed', market: MARKET_PDA, position: 'position-pda', owner: 'owner-pubkey',
      amount: 25n, asset: 'usdc', destination: 'exact-owner-ata',
    };

    await expect(fixture.value.project(event, context)).resolves.toEqual({
      kind: 'claim', marketId: MARKET_ID, ownerPubkey: 'owner-pubkey',
      destinationPubkey: 'exact-owner-ata', asset: 'usdc', amountAtomic: 25n, claimKind,
    });
    expect(fixture.accountReads()).toBe(0);
  });

  it('projects market close from historical DB identity after both accounts are gone', async () => {
    const fixture = projector('settled');
    const event: EscrowProgramEvent = {
      kind: 'MarketClosed', market: MARKET_PDA, dustAmount: 2n, asset: 'usdc',
    };

    await expect(fixture.value.project(event, context)).resolves.toEqual({
      kind: 'market_closed', marketId: MARKET_ID, marketPda: MARKET_PDA,
      documentHashHex: 'ab'.repeat(32), asset: 'usdc', dustAmountAtomic: 2n,
    });
    expect(fixture.accountReads()).toBe(0);
  });

  it('replays an activation after the position account closes without guessing its side', async () => {
    const fixture = projector('settled');
    const placed: EscrowProgramEvent = {
      kind: 'PositionPlaced', market: MARKET_PDA, position: 'position-pda', lot: 'lot-pda',
      owner: 'owner-pubkey', nonce: 0n, side: 'doubt', amount: 25n, asset: 'usdc',
      pending: true, eventEpoch: 3n, activationAfter: 100n,
      clientIntentHash: Uint8Array.from({ length: 32 }, () => 1),
    };
    const activated: EscrowProgramEvent = {
      kind: 'PositionActivated', market: MARKET_PDA, position: 'position-pda', lot: 'lot-pda',
      owner: 'owner-pubkey', nonce: 0n, amount: 25n, eventEpoch: 3n,
    };

    await fixture.value.project(placed, context);
    await expect(fixture.value.project(activated, context)).resolves.toMatchObject({
      kind: 'position', eventKind: 'activated', side: 'doubt', marketId: MARKET_ID,
    });
    expect(fixture.accountReads()).toBe(0);
  });

  it.each([
    ['MarketFrozen', 'frozen'],
    ['MarketUnfrozen', 'open'],
  ] as const)('projects finalized %s state for Telegram card refresh', async (kind, state) => {
    const fixture = projector('settled');
    const event: EscrowProgramEvent = {
      kind,
      market: MARKET_PDA,
      eventEpoch: 4n,
      evidenceHash: new Uint8Array(32).fill(7),
    };

    await expect(fixture.value.project(event, context)).resolves.toMatchObject({
      kind: 'market_state', marketId: MARKET_ID, state, eventEpoch: 4n,
      evidenceHashHex: '07'.repeat(32),
    });
    expect(fixture.accountReads()).toBe(0);
  });
});
