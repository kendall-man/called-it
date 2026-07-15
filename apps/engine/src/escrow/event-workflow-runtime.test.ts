import {
  deriveMarketPda,
  derivePositionLotPda,
  deriveUserPositionPda,
  type PositionLotAccount,
  type UserPositionAccount,
} from '@calledit/escrow-sdk';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import type { EscrowWorkflowMarketContext } from './event-workflow-scheduler.js';
import {
  createProductionEscrowEventWorkflowPort,
  createProductionEscrowSettlementPositionPort,
} from './event-workflow-runtime.js';
import type { DecodedEscrowAccount, SolanaEscrowAccountReader } from './solana-accounts.js';

const PROGRAM_ID = 'HrKUo8Bue31kU9sobzQGK5qDxVxBu5nBLXP3aGeKCDFL';
const MARKET_ID = '123e4567-e89b-12d3-a456-426614174000';

function lot(
  marketPda: string,
  ownerPubkey: string,
  nonce: bigint,
  eventEpoch: bigint,
  state: 'pending' | 'active',
): PositionLotAccount {
  return {
    version: 1, bump: 1, market: marketPda, owner: ownerPubkey, nonce, side: 'back',
    amount: 1n, placedTimestamp: 100n, placedSlot: 10n, observedEventEpoch: eventEpoch,
    state, activationTimestamp: state === 'active' ? 110n : null,
    invalidationEvidenceHash: null,
  };
}

function eventWorkflowFixture(input: {
  readonly fetch: (input: string | URL) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
  readonly readLot: SolanaEscrowAccountReader['lot'];
}) {
  const marketPda = deriveMarketPda(PROGRAM_ID, MARKET_ID).address;
  const context: EscrowWorkflowMarketContext = {
    chainState: 'open', replay: false,
    oraclePolicy: { oracleSetEpoch: 7n, signers: ['a', 'b', 'c'], threshold: 2 },
    binding: {
      marketId: MARKET_ID, marketPda, marketDocumentHashHex: 'ab'.repeat(32),
      fixtureId: 77n, oracleSetEpoch: 7n, eventEpoch: 3n,
    },
  };
  const accounts = { lot: input.readLot } as unknown as SolanaEscrowAccountReader;
  const port = createProductionEscrowEventWorkflowPort({
    supabaseUrl: 'https://example.supabase.co', serviceRoleKey: 'test-service-role',
    db: { async getMarketLink() { throw new Error('not used by positionLots'); } },
    accounts,
    deployment: {
      cluster: 'devnet', genesisHash: 'devnet-genesis', programId: PROGRAM_ID,
      custodyVersion: 1,
    },
    fetch: input.fetch,
  });
  return { context, marketPda, port };
}

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

describe('production escrow event workflow port', () => {
  it('pages production numeric lot rows deterministically and verifies every chain account', async () => {
    const ownerPubkey = Keypair.generate().publicKey.toBase58();
    const requests: URL[] = [];
    const rows = Array.from({ length: 1_001 }, (_, nonce) => ({
      owner_pubkey: ownerPubkey,
      lot_nonce: nonce,
      event_epoch: 3,
      state: nonce % 2 === 0 ? 'pending' as const : 'active' as const,
    }));
    const marketPda = deriveMarketPda(PROGRAM_ID, MARKET_ID).address;
    const accounts = new Map<string, DecodedEscrowAccount<PositionLotAccount>>();
    const fixture = eventWorkflowFixture({
      async fetch(input) {
        const url = new URL(input);
        requests.push(url);
        const offset = Number(url.searchParams.get('offset'));
        const limit = Number(url.searchParams.get('limit'));
        return { ok: true, async json() { return rows.slice(offset, offset + limit); } };
      },
      async readLot(address) { return accounts.get(address) ?? null; },
    });
    for (const row of rows) {
      const nonce = BigInt(row.lot_nonce);
      const address = derivePositionLotPda(PROGRAM_ID, marketPda, ownerPubkey, nonce).address;
      accounts.set(address, {
        address, ownerProgramId: PROGRAM_ID, lamports: 1n,
        value: lot(marketPda, ownerPubkey, nonce, 3n, row.state),
      });
    }

    const result = await fixture.port.positionLots(fixture.context);

    expect(result).toHaveLength(1_001);
    expect(result[0]).toMatchObject({ ownerPubkey, lotNonce: 0n, observedEventEpoch: 3n });
    expect(result[1_000]).toMatchObject({ ownerPubkey, lotNonce: 1_000n, observedEventEpoch: 3n });
    expect(requests).toHaveLength(2);
    expect(Object.fromEntries(requests[0]!.searchParams)).toMatchObject({
      market_id: `eq.${MARKET_ID}`, commitment: 'eq.finalized', canonical: 'eq.true',
      state: 'in.(pending,active)', order: 'owner_pubkey.asc,lot_nonce.asc',
      limit: '1000', offset: '0',
    });
    expect(requests[1]!.searchParams.get('offset')).toBe('1000');
  });

  it.each([
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
    ['fractional', 1.5],
    ['negative', -1],
  ])('rejects %s numeric lot projection values', async (_kind, lotNonce) => {
    const fixture = eventWorkflowFixture({
      async fetch() {
        return {
          ok: true,
          async json() {
            return [{ owner_pubkey: Keypair.generate().publicKey.toBase58(), lot_nonce: lotNonce, event_epoch: 3, state: 'pending' }];
          },
        };
      },
      async readLot() { throw new Error('invalid projections must not read chain state'); },
    });

    await expect(fixture.port.positionLots(fixture.context))
      .rejects.toThrow('invalid escrow lot integer');
  });

  it('rejects a projected lot that does not match chain identity', async () => {
    const ownerPubkey = Keypair.generate().publicKey.toBase58();
    const marketPda = deriveMarketPda(PROGRAM_ID, MARKET_ID).address;
    let expectedAddress = '';
    const fixture = eventWorkflowFixture({
      async fetch() {
        return {
          ok: true,
          async json() {
            return [{ owner_pubkey: ownerPubkey, lot_nonce: 4, event_epoch: 3, state: 'active' }];
          },
        };
      },
      async readLot(address) {
        expectedAddress = address;
        return {
          address, ownerProgramId: PROGRAM_ID, lamports: 1n,
          value: lot(marketPda, ownerPubkey, 5n, 3n, 'active'),
        };
      },
    });

    await expect(fixture.port.positionLots(fixture.context))
      .rejects.toThrow('escrow lot chain identity mismatch');
    expect(expectedAddress).toBe(
      derivePositionLotPda(PROGRAM_ID, marketPda, ownerPubkey, 4n).address,
    );
  });
});

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
