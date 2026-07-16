import {
  deriveMarketPda,
  derivePositionLotPda,
  deriveUserPositionPda,
  type MarketAccount,
  type UserPositionAccount,
} from '@calledit/escrow-sdk';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import type { DecodedEscrowAccount } from './solana-accounts.js';
import {
  createEscrowTerminalWorkflowOrchestrator,
  type EscrowTerminalPositionIdentity,
} from './terminal-workflow-orchestrator.js';
import { createEscrowTerminalPositionSource } from './terminal-workflow-position-source.js';
import type { EscrowRecoveryRequest } from './recovery-workflows.js';

const PROGRAM_ID = 'HrKUo8Bue31kU9sobzQGK5qDxVxBu5nBLXP3aGeKCDFL';
const MARKET_ID = '123e4567-e89b-12d3-a456-426614174000';
const MARKET_PDA = deriveMarketPda(PROGRAM_ID, MARKET_ID).address;

function decoded<T>(address: string, value: T): DecodedEscrowAccount<T> {
  return { address, ownerProgramId: PROGRAM_ID, lamports: 1n, value };
}

function marketAccount(overrides: Partial<MarketAccount> = {}): MarketAccount {
  return {
    version: 1,
    bump: 1,
    marketUuid: MARKET_ID,
    fixtureId: 77n,
    claimSpecificationHash: new Uint8Array(32),
    displayTermsHash: new Uint8Array(32),
    oddsMessageHash: new Uint8Array(32),
    marketDocumentHash: new Uint8Array(32),
    quoteTimestamp: 1n,
    probabilityPpm: 500_000,
    ratioMilli: 1_500,
    asset: 'sol',
    tokenMint: null,
    feeBps: 0,
    state: 'settled',
    replay: false,
    createdTimestamp: 1n,
    inPlayStartTimestamp: 2n,
    activationDelaySeconds: 30n,
    positionCutoffTimestamp: 3n,
    resolutionDeadline: 100n,
    oracleSetEpoch: 1n,
    eventEpoch: 1n,
    activeBackTotal: 20n,
    activeDoubtTotal: 20n,
    pendingBackTotal: 0n,
    pendingDoubtTotal: 0n,
    finalMatchedBackTotal: 20n,
    finalMatchedDoubtTotal: 20n,
    finalForfeitedTotal: 10n,
    settlementProcessedPositionCount: 0n,
    settlementOutcome: 'claim_won',
    settlementEvidenceHash: new Uint8Array(32),
    positionCount: 0n,
    claimedPositionCount: 0n,
    vault: Keypair.generate().publicKey.toBase58(),
    vaultBump: 1,
    residualRecipient: Keypair.generate().publicKey.toBase58(),
    ...overrides,
  };
}

function positionAccount(
  owner: string,
  overrides: Partial<UserPositionAccount> = {},
): UserPositionAccount {
  return {
    version: 1,
    bump: 1,
    market: MARKET_PDA,
    owner,
    side: 'back',
    activeAmount: 10n,
    pendingAmount: 0n,
    refundableAmount: 0n,
    settlementBaseEntitlement: 10n,
    settlementProcessed: true,
    nextLotNonce: 1n,
    claimed: false,
    totalPaidAmount: 10n,
    createdSlot: 1n,
    updatedSlot: 2n,
    ...overrides,
  };
}

function setup(input: {
  readonly market?: Partial<MarketAccount>;
  readonly positions?: readonly {
    readonly owner: string;
    readonly account?: Partial<UserPositionAccount> | null;
  }[];
  readonly now?: bigint;
  readonly blockedReasons?: readonly string[];
} = {}) {
  let market = marketAccount(input.market);
  const identities: EscrowTerminalPositionIdentity[] = [];
  const accounts = new Map<string, DecodedEscrowAccount<UserPositionAccount>>();
  const lots = new Set<string>();
  for (const item of input.positions ?? []) {
    const positionPda = deriveUserPositionPda(PROGRAM_ID, MARKET_PDA, item.owner).address;
    identities.push({ ownerPubkey: item.owner, positionPda });
    if (item.account !== null) {
      accounts.set(positionPda, decoded(positionPda, positionAccount(item.owner, item.account)));
    }
  }
  const requests: EscrowRecoveryRequest[] = [];
  const orchestrator = createEscrowTerminalWorkflowOrchestrator({
    programId: PROGRAM_ID,
    nowEpochSeconds: () => input.now ?? 200n,
    positions: { async positions() { return [...identities].reverse(); } },
    chain: {
      async market(address) { return address === MARKET_PDA ? decoded(address, market) : null; },
      async position(address) { return accounts.get(address) ?? null; },
      async accountExists(address) { return lots.has(address); },
    },
    recovery: {
      async enqueue(request) {
        requests.push(request);
        if (input.blockedReasons !== undefined) {
          return { kind: 'blocked' as const, reasons: input.blockedReasons };
        }
        return { kind: 'enqueued' as const, created: true, jobId: `job-${requests.length}` };
      },
    },
  });
  return {
    orchestrator,
    requests,
    identities,
    accounts,
    lots,
    setMarket(overrides: Partial<MarketAccount>) { market = { ...market, ...overrides }; },
    setPosition(owner: string, overrides: Partial<UserPositionAccount> | null) {
      const address = deriveUserPositionPda(PROGRAM_ID, MARKET_PDA, owner).address;
      if (overrides === null) accounts.delete(address);
      else accounts.set(address, decoded(address, positionAccount(owner, overrides)));
    },
  };
}

function progress(fixture: ReturnType<typeof setup>) {
  return fixture.orchestrator.progress({ marketId: MARKET_ID, marketPda: MARKET_PDA });
}

describe('escrow terminal workflow orchestrator', () => {
  it('schedules timeout void only after the immutable deadline', async () => {
    const early = setup({ market: { state: 'open', resolutionDeadline: 201n }, now: 200n });
    await expect(progress(early)).resolves.toMatchObject({
      state: 'waiting', reasons: ['resolution_deadline_not_reached'],
    });
    expect(early.requests).toEqual([]);

    const due = setup({ market: { state: 'frozen', resolutionDeadline: 200n }, now: 200n });
    await expect(progress(due)).resolves.toMatchObject({
      state: 'scheduled', scheduled: [{ operation: 'timeout_void', owner: null }],
    });
    expect(due.requests).toEqual([{ operation: 'timeout_void', marketPda: MARKET_PDA }]);
  });

  it('enqueues only missing settlement entitlements in deterministic owner order', async () => {
    const owners = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];
    const fixture = setup({
      market: {
        state: 'settling', positionCount: 2n, settlementProcessedPositionCount: 1n,
      },
      positions: [
        { owner: owners[0] ?? '', account: { settlementProcessed: false } },
        { owner: owners[1] ?? '', account: { settlementProcessed: true } },
      ],
    });

    await expect(progress(fixture)).resolves.toMatchObject({ state: 'scheduled' });
    expect(fixture.requests).toEqual([{
      operation: 'calculate_position_entitlement',
      marketPda: MARKET_PDA,
      owner: owners[0],
    }]);
  });

  it('progresses claims, lots, positions, and market across finalized ticks', async () => {
    const owners = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()]
      .sort();
    const first = owners[0] ?? '';
    const second = owners[1] ?? '';
    const fixture = setup({
      market: {
        state: 'settled', positionCount: 2n, claimedPositionCount: 1n,
        settlementProcessedPositionCount: 2n,
      },
      positions: [
        { owner: first, account: { claimed: false, nextLotNonce: 1n } },
        { owner: second, account: { claimed: true, nextLotNonce: 2n } },
      ],
    });
    fixture.lots.add(derivePositionLotPda(PROGRAM_ID, MARKET_PDA, second, 0n).address);
    fixture.lots.add(derivePositionLotPda(PROGRAM_ID, MARKET_PDA, second, 1n).address);

    await expect(progress(fixture)).resolves.toMatchObject({ state: 'scheduled' });
    expect(fixture.requests).toEqual([
      { operation: 'claim_position_for', marketPda: MARKET_PDA, owner: first },
      {
        operation: 'close_position_lots', marketPda: MARKET_PDA, owner: second,
        lotNonces: [1n, 0n],
      },
    ]);

    fixture.requests.length = 0;
    fixture.setMarket({ claimedPositionCount: 2n });
    fixture.setPosition(first, { claimed: true, nextLotNonce: 0n });
    fixture.setPosition(second, { claimed: true, nextLotNonce: 0n });
    await expect(progress(fixture)).resolves.toMatchObject({ state: 'scheduled' });
    expect(fixture.requests).toEqual([
      { operation: 'close_position', marketPda: MARKET_PDA, owner: first },
      { operation: 'close_position', marketPda: MARKET_PDA, owner: second },
    ]);

    fixture.requests.length = 0;
    fixture.setPosition(first, null);
    fixture.setPosition(second, null);
    fixture.setMarket({ settlementProcessedPositionCount: 0n });
    await expect(progress(fixture)).resolves.toMatchObject({
      state: 'scheduled', scheduled: [{ operation: 'close_market', owner: null }],
    });
    expect(fixture.requests).toEqual([{ operation: 'close_market', marketPda: MARKET_PDA }]);
  });

  it('closes a large position in descending transaction-safe batches across finalized ticks', async () => {
    const owner = Keypair.generate().publicKey.toBase58();
    const fixture = setup({
      market: {
        state: 'settled', positionCount: 1n, claimedPositionCount: 1n,
        settlementProcessedPositionCount: 1n,
      },
      positions: [{ owner, account: { claimed: true, nextLotNonce: 10n } }],
    });
    for (let nonce = 0n; nonce < 10n; nonce += 1n) {
      fixture.lots.add(derivePositionLotPda(PROGRAM_ID, MARKET_PDA, owner, nonce).address);
    }

    await expect(progress(fixture)).resolves.toMatchObject({ state: 'scheduled' });
    expect(fixture.requests).toEqual([{
      operation: 'close_position_lots', marketPda: MARKET_PDA, owner,
      lotNonces: [9n, 8n, 7n, 6n, 5n, 4n, 3n, 2n],
    }]);

    fixture.requests.length = 0;
    fixture.setPosition(owner, { claimed: true, nextLotNonce: 2n });
    await expect(progress(fixture)).resolves.toMatchObject({ state: 'scheduled' });
    expect(fixture.requests).toEqual([{
      operation: 'close_position_lots', marketPda: MARKET_PDA, owner,
      lotNonces: [1n, 0n],
    }]);
  });

  it('auto-claims a void refund without requiring settlement entitlement', async () => {
    const owner = Keypair.generate().publicKey.toBase58();
    const fixture = setup({
      market: {
        state: 'voided', settlementOutcome: 'void', positionCount: 1n,
        claimedPositionCount: 0n, settlementProcessedPositionCount: 1n,
      },
      positions: [{ owner, account: { settlementProcessed: false, claimed: false } }],
    });

    await progress(fixture);
    expect(fixture.requests).toEqual([{
      operation: 'claim_position_for', marketPda: MARKET_PDA, owner,
    }]);
  });

  it('fails closed on projection, counter, and lot-account mismatches', async () => {
    const owner = Keypair.generate().publicKey.toBase58();
    const projection = setup({ market: { positionCount: 1n } });
    await expect(progress(projection)).resolves.toMatchObject({
      state: 'waiting', reasons: ['position_projection_incomplete'],
    });

    const counters = setup({
      market: { positionCount: 1n, settlementProcessedPositionCount: 0n },
      positions: [{ owner, account: { claimed: false } }],
    });
    await expect(progress(counters)).resolves.toMatchObject({
      state: 'waiting', reasons: ['terminal_counter_mismatch'],
    });

    const lot = setup({
      market: {
        positionCount: 1n, claimedPositionCount: 1n, settlementProcessedPositionCount: 1n,
      },
      positions: [{ owner, account: { claimed: true, nextLotNonce: 1n } }],
    });
    await expect(progress(lot)).resolves.toMatchObject({
      state: 'waiting', reasons: ['position_lot_account_missing'],
    });
    expect(lot.requests).toEqual([]);
  });

  it('surfaces recovery readiness blocks without claiming completion', async () => {
    const fixture = setup({
      market: { state: 'open', resolutionDeadline: 1n },
      blockedReasons: ['escrow_runtime_timeout'],
    });
    await expect(progress(fixture)).resolves.toMatchObject({
      state: 'blocked', reasons: ['escrow_runtime_timeout'], scheduled: [],
    });
  });
});

describe('escrow terminal position source', () => {
  it('reads every finalized canonical position projection page', async () => {
    const rows = [
      { owner_pubkey: 'owner-a', position_pda: 'position-a' },
      { owner_pubkey: 'owner-b', position_pda: 'position-b' },
      { owner_pubkey: 'owner-c', position_pda: 'position-c' },
    ];
    const offsets: string[] = [];
    const source = createEscrowTerminalPositionSource({
      supabaseUrl: 'https://example.supabase.co',
      serviceRoleKey: 'test-key',
      pageSize: 2,
      async fetch(input) {
        const url = new URL(input);
        const offset = url.searchParams.get('offset') ?? '0';
        offsets.push(offset);
        expect(url.searchParams.get('commitment')).toBe('eq.finalized');
        expect(url.searchParams.get('canonical')).toBe('eq.true');
        const start = Number(offset);
        return {
          ok: true,
          async json() { return rows.slice(start, start + 2); },
        };
      },
    });

    await expect(source.positions({ marketId: MARKET_ID, marketPda: MARKET_PDA }))
      .resolves.toEqual([
        { ownerPubkey: 'owner-a', positionPda: 'position-a' },
        { ownerPubkey: 'owner-b', positionPda: 'position-b' },
        { ownerPubkey: 'owner-c', positionPda: 'position-c' },
      ]);
    expect(offsets).toEqual(['0', '2']);
  });
});
