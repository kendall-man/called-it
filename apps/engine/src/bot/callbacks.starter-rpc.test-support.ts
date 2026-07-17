import type { FakeWagerDb } from '../wager/fakes.js';

export function installAtomicStarterRpc(
  db: FakeWagerDb,
  starterBudgetEnabled: boolean,
): void {
  const standardStake = db.wagerStake.bind(db);
  const locks = new Map<number, Promise<void>>();
  db.wagerStake = async (args) => {
    const prior = locks.get(args.user_id) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = prior.then(() => current);
    locks.set(args.user_id, queued);
    await prior;
    try {
      const ledgerKey = `wager:stake:api:${args.idempotency_key ?? ''}`;
      db.lastStakeArgs = args;
      if (args.idempotency_key !== undefined && db.ledgerByKey(ledgerKey) !== undefined) {
        return { ok: true, duplicate: true };
      }
      const hasHistory =
        db.ledger.some((entry) => entry.user_id === args.user_id) ||
        db.positions.some((position) => position.user_id === args.user_id);
      if (args.starterOnly && args.lamports === 10_000_000n && !hasHistory) {
        if (!starterBudgetEnabled) return { ok: false, code: 'starter_unavailable' };
        const oppositeSide = db.positions.some(
          (position) =>
            position.market_id === args.market_id &&
            position.user_id === args.user_id &&
            position.side !== args.side &&
            position.state !== 'void',
        );
        if (oppositeSide) return { ok: false, code: 'wrong_side' };
        const positionId = `starter-position-${db.positions.length + 1}`;
        db.positions.push({
          id: positionId,
          market_id: args.market_id,
          user_id: args.user_id,
          side: args.side,
          stake: Number(args.lamports),
          locked_multiplier: args.multiplier,
          state: args.state,
          placed_at_ms: args.placed_at_ms,
        });
        await db.postWagerLedger({
          user_id: args.user_id,
          group_id: args.group_id,
          market_id: args.market_id,
          kind: 'starter_grant',
          lamports: args.lamports,
          idempotency_key: `wager:starter:${args.user_id}`,
        });
        await db.postWagerLedger({
          user_id: args.user_id,
          group_id: args.group_id,
          market_id: args.market_id,
          kind: 'stake',
          lamports: -args.lamports,
          idempotency_key: ledgerKey,
        });
        return { ok: true, position_id: positionId };
      }
      if (!db.links.has(args.user_id)) return { ok: false, code: 'wallet_required' };
      return standardStake(args);
    } finally {
      release();
      if (locks.get(args.user_id) === queued) locks.delete(args.user_id);
    }
  };
}
