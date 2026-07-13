import { describe, expect, it } from 'vitest';
import { DbError } from './errors.js';
import {
  GROUP_ID,
  MARKET_ID,
  NOW_ISO,
  USER_ID,
  makeHarness,
} from './wager-db-test-support.js';

describe('table query boundary', () => {
  it('rejects malformed account rows selected from the database', async () => {
    const group = makeHarness();
    group.fake.seed('wager_groups', [{ group_id: GROUP_ID, enabled: 'true' }]);
    await expect(group.db.isGroupEnabled(GROUP_ID)).rejects.toThrow(DbError);

    const wallet = makeHarness();
    wallet.fake.seed('wager_wallet_links', [{ user_id: USER_ID }]);
    await expect(wallet.db.getWalletLink(USER_ID)).rejects.toThrow(DbError);

    const walletByPubkey = makeHarness();
    walletByPubkey.fake.seed('wager_wallet_links', [{ user_id: USER_ID, pubkey: 'valid-pubkey', created_at: 99 }]);
    await expect(walletByPubkey.db.getWalletLinkByPubkey('valid-pubkey')).rejects.toThrow(DbError);
  });

  it('rejects malformed settlement and status rows selected from the database', async () => {
    const probability = makeHarness();
    probability.fake.seed('markets', [{ id: MARKET_ID, quote_probability: '0.5' }]);
    await expect(probability.db.getMarketProbability(MARKET_ID)).rejects.toThrow(DbError);

    const settlement = makeHarness();
    settlement.fake.seed('settlements', [{ market_id: MARKET_ID, outcome: 'unexpected' }]);
    await expect(settlement.db.getSettlementOutcome(MARKET_ID)).rejects.toThrow(DbError);

    const status = makeHarness();
    status.fake.seed('wager_status', [
      { id: 1, paused: 'false', reason: null, updated_at: NOW_ISO },
    ]);
    await expect(status.db.getWagerStatus()).rejects.toThrow(DbError);
  });

  it('rejects malformed market IDs selected from the database', async () => {
    const settled = makeHarness();
    settled.fake.seed('markets', [{ id: 42, currency: 'sol', status: 'settled', is_replay: false }]);
    await expect(settled.db.settledSolMarketsMissingApplied()).rejects.toThrow(DbError);

    const open = makeHarness();
    open.fake.seed('markets', [{ id: 42, currency: 'sol', status: 'open' }]);
    await expect(open.db.openSolMarketIds()).rejects.toThrow(DbError);
  });
});
