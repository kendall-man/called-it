import assert from 'node:assert/strict';
import test from 'node:test';
import { withFreshGroupPointsDb } from './sql-harness/group-points-db.js';

const GROUP_ID = -100_000_000_022;
const CALLER_ID = 22_001;
const PLAYER_ID = 22_002;
const FIXTURE_ID = 22_003;
const MARKET_ID = '00000000-0000-4000-8000-000000000022';
const REPLAY_MARKET_ID = '00000000-0000-4000-8000-000000000023';
const WALLET = 'UsdcWalletOwner11111111111111111111111111111';

test('USDC fund, stake, settle, points, receipt, withdrawal, and replay stay asset-safe', async () => {
  await withFreshGroupPointsDb(async (client) => {
    await client.query(
      `insert into groups (id, title, slug, points_started_at)
       values ($1, 'USDC test group', 'usdc-test-group', clock_timestamp() - interval '1 minute')`,
      [GROUP_ID],
    );
    await client.query(
      `insert into users (id, display_name) values
       ($1, 'Caller'), ($2, 'Player')`,
      [CALLER_ID, PLAYER_ID],
    );
    await client.query(
      `insert into fixtures (fixture_id, p1_name, p2_name)
       values ($1, 'France', 'Morocco')`,
      [FIXTURE_ID],
    );
    const claims = await client.query<{ id: string }>(
      `insert into claims (group_id, claimer_user_id, tg_message_id, quoted_text)
       values
       ($1, $2, 22001, 'France will win'),
       ($1, $2, 22002, 'France won')
       returning id`,
      [GROUP_ID, CALLER_ID],
    );
    const liveClaimId = claims.rows[0]?.id;
    const replayClaimId = claims.rows[1]?.id;
    assert.ok(liveClaimId);
    assert.ok(replayClaimId);

    await client.query(
      `insert into wager_groups (group_id, enabled, enabled_by, default_asset)
       values ($1, true, $2, 'usdc')`,
      [GROUP_ID, CALLER_ID],
    );
    const history = await client.query<{ id: string }>(
      `insert into wager_wallet_link_history (user_id, pubkey, verified_at)
       values ($1, $2, now()) returning id`,
      [PLAYER_ID, WALLET],
    );
    await client.query(
      `insert into wager_wallet_links
         (user_id, pubkey, verified_at, link_history_id)
       values ($1, $2, now(), $3)`,
      [PLAYER_ID, WALLET, history.rows[0]?.id],
    );
    await client.query(
      `insert into markets
         (id, claim_id, group_id, fixture_id, spec, status, price_provenance,
          quote_probability, quote_multiplier, currency)
       values
         ($1, $2, $3, $4, '{"trustTier":"oracle_resolved"}', 'open',
          'market', 0.5, 2, 'usdc')`,
      [MARKET_ID, liveClaimId, GROUP_ID, FIXTURE_ID],
    );
    await client.query(
      `insert into wager_ledger_entries
         (user_id, kind, lamports, asset, idempotency_key)
       values ($1, 'deposit', 5000000, 'usdc', 'usdc-test-deposit')`,
      [PLAYER_ID],
    );

    const stake = await client.query<{ result: Record<string, unknown> }>(
      `select wager_stake($1,$2,$3,'back',1000000,2,'active',22000,'usdc-test-stake',false) as result`,
      [PLAYER_ID, GROUP_ID, MARKET_ID],
    );
    assert.equal(stake.rows[0]?.result.ok, true);
    const stakeLedger = await client.query<{ asset: string; lamports: string }>(
      `select asset, lamports::text from wager_ledger_entries
       where idempotency_key = 'wager:stake:api:usdc-test-stake'`,
    );
    assert.deepEqual(stakeLedger.rows, [{ asset: 'usdc', lamports: '-1000000' }]);

    const terminal = await client.query<{ result: Record<string, unknown> }>(
      `select settlement_record_terminal(
         $1, 'claim_won', 1, array[1]::bigint[], 'oracle_resolved', now(),
         5, 30000, 1000, 60000
       ) as result`,
      [MARKET_ID],
    );
    assert.equal(terminal.rows[0]?.result.ok, true);
    const points = await client.query<{ result: Record<string, unknown> }>(
      'select group_points_apply($1) as result',
      [MARKET_ID],
    );
    assert.equal(points.rows[0]?.result.eligible, true);
    assert.equal(points.rows[0]?.result.winner_count, 1);
    const score = await client.query<{ points: string; wins: string }>(
      `select points::text, wins::text from group_player_stats
       where group_id = $1 and user_id = $2`,
      [GROUP_ID, PLAYER_ID],
    );
    assert.deepEqual(score.rows, [{ points: '10', wins: '1' }]);

    const receipt = await client.query<{ currency: string; back_pot_atomic: string }>(
      `select currency, back_pot_atomic from public_receipts where market_id = $1`,
      [MARKET_ID],
    );
    assert.deepEqual(receipt.rows, [{ currency: 'usdc', back_pot_atomic: '1000000' }]);

    const withdrawal = await client.query<{ result: Record<string, unknown> }>(
      `select wager_request_withdrawal($1, 'usdc', 1000000) as result`,
      [PLAYER_ID],
    );
    assert.equal(withdrawal.rows[0]?.result.ok, true);
    const withdrawalAsset = await client.query<{ asset: string; lamports: string }>(
      `select asset, lamports::text from wager_withdrawals where user_id = $1`,
      [PLAYER_ID],
    );
    assert.deepEqual(withdrawalAsset.rows, [{ asset: 'usdc', lamports: '1000000' }]);

    await client.query(
      `insert into markets
         (id, claim_id, group_id, fixture_id, spec, status, is_replay,
          price_provenance, quote_probability, quote_multiplier, currency)
       values
         ($1, $2, $3, $4, '{"trustTier":"oracle_resolved"}', 'open', true,
          'market', 0.5, 2, 'usdc')`,
      [REPLAY_MARKET_ID, replayClaimId, GROUP_ID, FIXTURE_ID],
    );
    const ledgerBeforeReplay = await client.query<{ count: string }>(
      'select count(*)::text as count from wager_ledger_entries',
    );
    const replay = await client.query<{ result: Record<string, unknown> }>(
      `select place_replay_position($1,$2,$3,'back',1000000,2,'active',23000) as result`,
      [PLAYER_ID, GROUP_ID, REPLAY_MARKET_ID],
    );
    assert.equal(replay.rows[0]?.result.ok, true);
    const ledgerAfterReplay = await client.query<{ count: string }>(
      'select count(*)::text as count from wager_ledger_entries',
    );
    assert.deepEqual(ledgerAfterReplay.rows, ledgerBeforeReplay.rows);
  });
});
