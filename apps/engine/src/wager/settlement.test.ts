import { describe, expect, it } from 'vitest';
import {
  applySettlement,
  createSettlementSweeper,
  settlementPayoutsLine,
} from './settlement.js';
import { WAGER_KEYS } from './constants.js';
import { makeFakeDeps } from './fakes.js';

// p=0.5 → ratio 1000 → 1:1 peer matching, so the expected numbers stay round.
const EVEN = 0.5;

describe('applySettlement — peer-matched', () => {
  it('refuses to credit a replay position that has no matching stake debit', async () => {
    const errors: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const { deps, db } = makeFakeDeps({
      log: {
        info() {},
        warn() {},
        error(event, fields) { errors.push({ event, fields }); },
      },
    });
    db.settlements.set('legacy-replay', 'claim_won');
    db.seedMarketProbability('legacy-replay', EVEN);
    db.seedPosition({ market_id: 'legacy-replay', user_id: 1, side: 'back' });

    await applySettlement(deps, 'legacy-replay', { requireFullyBacked: true });

    expect(db.ledger.filter((entry) => entry.kind === 'payout' || entry.kind === 'refund'))
      .toHaveLength(0);
    expect(db.applied.has('legacy-replay')).toBe(false);
    expect(errors).toContainEqual({
      event: 'wager_settlement_unbacked_positions',
      fields: {
        marketId: 'legacy-replay',
        positionLamports: '10000000',
        debitedLamports: '0',
      },
    });
  });

  it('settles a replay after every position lamport is backed by a stake debit', async () => {
    const { deps, db } = makeFakeDeps();
    db.settlements.set('funded-replay', 'claim_won');
    db.seedMarketProbability('funded-replay', EVEN);
    const winner = db.seedPosition({ market_id: 'funded-replay', user_id: 1, side: 'back' });
    await db.postWagerLedger({
      user_id: 1,
      group_id: -100,
      market_id: 'funded-replay',
      kind: 'stake',
      lamports: -10_000_000n,
      idempotency_key: 'wager:stake:funded-replay',
    });

    await applySettlement(deps, 'funded-replay', { requireFullyBacked: true });

    expect(db.ledgerByKey(WAGER_KEYS.payout('funded-replay', winner.user_id))?.lamports)
      .toBe(10_000_000n);
    expect(db.applied.has('funded-replay')).toBe(true);
  });

  it('pays the winner stake + matched losing pot, refunds pending, voids pending, stamps marker', async () => {
    const { deps, db } = makeFakeDeps();
    db.settlements.set('m1', 'claim_won');
    db.seedMarketProbability('m1', EVEN);
    const winner = db.seedPosition({ market_id: 'm1', user_id: 1, side: 'back', stake: 40_000_000 });
    const loser = db.seedPosition({ market_id: 'm1', user_id: 2, side: 'doubt', stake: 40_000_000 });
    const pending = db.seedPosition({ market_id: 'm1', user_id: 3, side: 'back', stake: 10_000_000, state: 'pending' });
    const voided = db.seedPosition({ market_id: 'm1', user_id: 4, side: 'back', stake: 10_000_000, state: 'void' });

    await applySettlement(deps, 'm1');

    // Back wins: 40M matched 1:1, so the winner gets 40M stake + 40M forfeited.
    expect(db.ledgerByKey(WAGER_KEYS.payout('m1', 1))?.lamports).toBe(80_000_000n);
    // Loser was fully matched → forfeits everything → no remainder refund.
    expect(db.ledgerByKey(WAGER_KEYS.refund(loser.id))).toBeUndefined();
    expect(db.ledgerByKey(WAGER_KEYS.payout('m1', 2))).toBeUndefined();
    // Pending + already-voided sol stakes are only ever refunded here.
    expect(db.ledgerByKey(WAGER_KEYS.refund(pending.id))?.lamports).toBe(10_000_000n);
    expect(db.ledgerByKey(WAGER_KEYS.refund(voided.id))?.lamports).toBe(10_000_000n);
    expect(pending.state).toBe('void');
    expect(winner.state).toBe('active');
    expect(db.applied.has('m1')).toBe(true);
  });

  it('settles a USDC market entirely in USDC atomic units', async () => {
    const { deps, db } = makeFakeDeps();
    db.settlements.set('usdc-market', 'claim_won');
    db.seedMarketProbability('usdc-market', EVEN);
    db.seedMarketAsset('usdc-market', 'usdc');
    db.seedPosition({ market_id: 'usdc-market', user_id: 1, side: 'back', stake: 1_000_000 });
    db.seedPosition({ market_id: 'usdc-market', user_id: 2, side: 'doubt', stake: 1_000_000 });

    await applySettlement(deps, 'usdc-market');

    expect(db.ledgerByKey(WAGER_KEYS.payout('usdc-market', 1))).toMatchObject({
      asset: 'usdc',
      lamports: 2_000_000n,
    });
    expect(db.ledger.filter((entry) => entry.market_id === 'usdc-market')
      .every((entry) => entry.asset === 'usdc')).toBe(true);
  });

  it('refunds the unmatched excess on the heavier side', async () => {
    const { deps, db } = makeFakeDeps();
    db.settlements.set('m1', 'claim_won');
    db.seedMarketProbability('m1', EVEN);
    db.seedPosition({ market_id: 'm1', user_id: 1, side: 'back', stake: 60_000_000 });
    const loser = db.seedPosition({ market_id: 'm1', user_id: 2, side: 'doubt', stake: 20_000_000 });

    await applySettlement(deps, 'm1');

    // Only 20M each side matched: winner gets 60M back + 20M won.
    expect(db.ledgerByKey(WAGER_KEYS.payout('m1', 1))?.lamports).toBe(80_000_000n);
    // Loser fully matched (20M) → no remainder.
    expect(db.ledgerByKey(WAGER_KEYS.refund(loser.id))).toBeUndefined();
  });

  it('refunds everyone when no one took the other side', async () => {
    const { deps, db } = makeFakeDeps();
    db.settlements.set('m1', 'claim_won');
    db.seedMarketProbability('m1', 0.6);
    db.seedPosition({ market_id: 'm1', user_id: 1, side: 'back', stake: 50_000_000 });

    await applySettlement(deps, 'm1');
    // Nothing matched → the backer's payout is just their own stake back.
    expect(db.ledgerByKey(WAGER_KEYS.payout('m1', 1))?.lamports).toBe(50_000_000n);
  });

  it('is idempotent — a second run adds zero ledger entries', async () => {
    const { deps, db } = makeFakeDeps();
    db.settlements.set('m1', 'claim_won');
    db.seedMarketProbability('m1', EVEN);
    db.seedPosition({ market_id: 'm1', user_id: 1, side: 'back', stake: 40_000_000 });
    db.seedPosition({ market_id: 'm1', user_id: 2, side: 'doubt', stake: 40_000_000 });

    await applySettlement(deps, 'm1');
    const after = db.ledger.length;
    await applySettlement(deps, 'm1');
    expect(db.ledger.length).toBe(after);
  });

  it('re-run converges even when the marker write crashed the first time', async () => {
    const { deps, db } = makeFakeDeps();
    db.settlements.set('m1', 'claim_won');
    db.seedMarketProbability('m1', EVEN);
    db.seedPosition({ market_id: 'm1', user_id: 1, side: 'back' });
    await applySettlement(deps, 'm1');
    const after = db.ledger.length;
    db.applied.delete('m1'); // money moved but the marker never landed
    await applySettlement(deps, 'm1');
    expect(db.ledger.length).toBe(after);
    expect(db.applied.has('m1')).toBe(true);
  });

  it('re-run completes a partially applied void without duplicating an already credited refund', async () => {
    // Given a crash after one idempotent refund landed but before the applied marker
    const { deps, db } = makeFakeDeps();
    db.settlements.set('m1', 'void');
    db.seedMarketProbability('m1', EVEN);
    const first = db.seedPosition({ market_id: 'm1', user_id: 1, stake: 10_000_000 });
    const second = db.seedPosition({ market_id: 'm1', user_id: 2, stake: 20_000_000 });
    await db.postWagerLedger({
      user_id: first.user_id,
      group_id: null,
      market_id: 'm1',
      kind: 'refund',
      lamports: 10_000_000n,
      idempotency_key: WAGER_KEYS.refund(first.id),
    });

    // When durable settlement recovery reapplies the whole market
    await applySettlement(deps, 'm1');

    // Then the existing credit is reused, the missing credit lands, and only then is it marked applied
    expect(db.ledger.filter((entry) => entry.idempotency_key === WAGER_KEYS.refund(first.id))).toHaveLength(1);
    expect(db.ledgerByKey(WAGER_KEYS.refund(second.id))?.lamports).toBe(20_000_000n);
    expect(db.applied.has('m1')).toBe(true);
  });

  it('void refunds every position (including already-voided) and pays nobody', async () => {
    const { deps, db } = makeFakeDeps();
    db.settlements.set('m1', 'void');
    db.seedMarketProbability('m1', EVEN);
    const active = db.seedPosition({ market_id: 'm1', user_id: 1, side: 'back', stake: 10_000_000 });
    const pending = db.seedPosition({ market_id: 'm1', user_id: 2, side: 'doubt', stake: 50_000_000, state: 'pending' });
    const voided = db.seedPosition({ market_id: 'm1', user_id: 3, state: 'void', stake: 10_000_000 });

    await applySettlement(deps, 'm1');

    expect(db.ledgerByKey(WAGER_KEYS.refund(active.id))?.lamports).toBe(10_000_000n);
    expect(db.ledgerByKey(WAGER_KEYS.refund(pending.id))?.lamports).toBe(50_000_000n);
    expect(db.ledgerByKey(WAGER_KEYS.refund(voided.id))?.lamports).toBe(10_000_000n);
    expect(db.ledger.filter((entry) => entry.kind === 'payout')).toHaveLength(0);
  });

  it('does nothing for an unsettled market', async () => {
    const { deps, db } = makeFakeDeps();
    db.seedPosition({ market_id: 'm1' });
    await applySettlement(deps, 'm1');
    expect(db.ledger).toHaveLength(0);
    expect(db.applied.size).toBe(0);
  });

  it('refuses to settle without the market probability (never guesses the ratio)', async () => {
    const { deps, db } = makeFakeDeps();
    db.settlements.set('m1', 'claim_won'); // settled, but no probability seeded
    db.seedPosition({ market_id: 'm1', user_id: 1, side: 'back' });
    await applySettlement(deps, 'm1');
    expect(db.ledger).toHaveLength(0);
    expect(db.applied.has('m1')).toBe(false);
  });
});

describe('settlementPayoutsLine', () => {
  it('projects 100 unique winners through one bounded sanitized bulk read', async () => {
    // Given 100 winners, 100 losers, and one duplicate winning position
    const { deps, db } = makeFakeDeps();
    db.seedMarketProbability('m1', EVEN);
    const winnerIds = Array.from({ length: 100 }, (_, index) => 10_000 + index);
    const loserIds = Array.from({ length: 100 }, (_, index) => 20_000 + index);
    for (const [index, userId] of [...winnerIds].reverse().entries()) {
      db.users.set(
        userId,
        `\u0000\u202e\uD800Winner ${100 - index} ${'🏆'.repeat(80)} @raw_winner_${userId} id:${userId}\n`,
      );
      db.seedPosition({ market_id: 'm1', user_id: userId, side: 'back', stake: 1_000_000 });
    }
    db.seedPosition({ market_id: 'm1', user_id: 10_000, side: 'back', stake: 1_000_000 });
    for (const [index, userId] of loserIds.entries()) {
      db.seedPosition({
        market_id: 'm1',
        user_id: userId,
        side: 'doubt',
        stake: index === 0 ? 2_000_000 : 1_000_000,
      });
    }
    const bulkQueries: number[][] = [];
    let sequentialReads = 0;
    const getUserName = db.getUserName.bind(db);
    Object.assign(db, {
      getUserName: async (userId: number) => {
        sequentialReads += 1;
        return getUserName(userId);
      },
      getUserNames: async (userIds: readonly number[]) => {
        bulkQueries.push([...userIds]);
        return new Map(
          userIds.map((userId) => [userId, db.users.get(userId) ?? 'Missing winner']),
        );
      },
    });

    // When the production payout formatter projects the winning side
    const line = await settlementPayoutsLine(deps, 'm1', 'claim_won');

    // Then selection is deterministic, duplicate-free, bounded, and presentation-safe
    expect({
      bulkQueries,
      sequentialReads,
      firstWinnerOccurrences: line.match(/Winner 1 /g)?.length ?? 0,
      hasAuthoritativeOverflow: line.includes('and 95 more winners'),
      hidesSixthWinner: !line.includes('Winner 6 '),
      hidesRawIdentity: !line.includes('@raw_winner_') && !line.includes('id:10000'),
      controlSafe: !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(line),
      unicodeSafe: !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(line),
      bounded: line.length <= 512,
      devnet: line.endsWith('(devnet)'),
    }).toEqual({
      bulkQueries: [winnerIds.slice(0, 5)],
      sequentialReads: 0,
      firstWinnerOccurrences: 1,
      hasAuthoritativeOverflow: true,
      hidesSixthWinner: true,
      hidesRawIdentity: true,
      controlSafe: true,
      unicodeSafe: true,
      bounded: true,
      devnet: true,
    });
  });

  it('names each winner with exact SOL and a devnet stamp', async () => {
    const { deps, db } = makeFakeDeps();
    db.users.set(1, 'Sana');
    db.seedMarketProbability('m1', EVEN);
    db.seedPosition({ market_id: 'm1', user_id: 1, side: 'back', stake: 10_000_000 });
    db.seedPosition({ market_id: 'm1', user_id: 2, side: 'doubt', stake: 10_000_000 });
    const line = await settlementPayoutsLine(deps, 'm1', 'claim_won');
    // 10M stake + 10M matched-and-won = 20M = 0.02 SOL.
    expect(line).toBe('Sana collects 0.02 SOL. (devnet)');
  });

  it('uses a stable label instead of a missing winner name or id', async () => {
    const { deps, db } = makeFakeDeps();
    db.seedMarketProbability('m1', EVEN);
    db.seedPosition({ market_id: 'm1', user_id: 42, side: 'back', stake: 10_000_000 });
    db.seedPosition({ market_id: 'm1', user_id: 99, side: 'doubt', stake: 10_000_000 });

    const line = await settlementPayoutsLine(deps, 'm1', 'claim_won');

    expect(line).toBe('Player collects 0.02 SOL. (devnet)');
    expect(line).not.toContain('42');
  });

  it('void and no-winner lines are distinct', async () => {
    const { deps } = makeFakeDeps();
    const voidLine = await settlementPayoutsLine(deps, 'm1', 'void');
    const noneLine = await settlementPayoutsLine(deps, 'm1', 'claim_won');
    expect(voidLine).toBe('Call off — every SOL position returned. (devnet)');
    expect(noneLine).toBe('No SOL changed hands. (devnet)');
  });
});

describe('settlement sweeper', () => {
  it('applies any settled sol market missing the marker, then goes quiet', async () => {
    const { deps, db } = makeFakeDeps();
    db.settlements.set('m1', 'claim_won');
    db.seedMarketProbability('m1', 0.6);
    db.settlements.set('m2', 'void');
    db.applied.add('m2');
    const winner = db.seedPosition({ market_id: 'm1', user_id: 1, side: 'back' });

    const sweeper = createSettlementSweeper(deps);
    await sweeper.tick();
    expect(db.applied.has('m1')).toBe(true);
    expect(db.ledgerByKey(WAGER_KEYS.payout('m1', winner.user_id))).toBeDefined();

    const after = db.ledger.length;
    await sweeper.tick();
    expect(db.ledger.length).toBe(after);
  });

  it('recovers funded replay settlements with backing validation', async () => {
    const { deps, db } = makeFakeDeps();
    db.settlements.set('funded-replay', 'claim_won');
    db.seedMarketProbability('funded-replay', EVEN);
    const winner = db.seedPosition({ market_id: 'funded-replay', user_id: 1, side: 'back' });
    await db.postWagerLedger({
      user_id: 1,
      group_id: -100,
      market_id: 'funded-replay',
      kind: 'stake',
      lamports: -10_000_000n,
      idempotency_key: 'wager:stake:funded-replay',
    });
    db.fundedReplayMarkets.push('funded-replay');

    await createSettlementSweeper(deps).tick();

    expect(db.ledgerByKey(WAGER_KEYS.payout('funded-replay', winner.user_id))).toBeDefined();
    expect(db.applied.has('funded-replay')).toBe(true);
  });
});
