-- Called It — wager mode (devnet SOL), additive on 0001_init.sql.
--
-- NEVER apply this migration to the Supabase project backing the hackathon
-- demo — wager mode runs against a separate, devnet-dedicated project.
--
-- Posture: the engine writes via service_role only. There is NO anon surface
-- for anything wager-related: every wager_* table has RLS enabled with ZERO
-- policies, no view exposes them, and none is added to supabase_realtime —
-- wallet pubkeys and per-user lamports are structurally unreachable from web.

-- ── markets.currency — the ONLY change to an existing table ────────────────
-- Stamped atomically at mint (insertMarket passes the column through), so a
-- market can never exist without its currency. Default 'rep' keeps every
-- existing row and every Rep code path byte-identical to main; the
-- public_receipts view selects explicit columns, so nothing leaks to web.
alter table markets add column currency text not null default 'rep'
  check (currency in ('rep', 'sol'));

-- ── wager tables (all new, all prefixed wager_) ────────────────────────────

-- Per-group admin opt-in. Toggling never changes live markets: currency is
-- stamped at mint and immutable afterwards.
create table wager_groups (
  group_id   bigint primary key references groups(id),
  enabled    boolean not null default false,
  enabled_by bigint not null references users(id),  -- admin who last toggled
  updated_at timestamptz not null default now()
);

create table wager_wallet_links (
  user_id             bigint primary key references users(id),
  pubkey              text not null unique,          -- first-link-wins
  -- NOTIFICATION routing only (deposit-credited group post) — never fund
  -- routing; balances are user-global, deposits are not group-scoped.
  last_wager_group_id bigint references groups(id),
  verified_at         timestamptz,                   -- first credited deposit from this pubkey
  created_at          timestamptz not null default now()
);

-- User-global lamports ledger (balance = sum by user_id). Fully separate from
-- Rep's ledger_entries so no Rep query can ever pick up a lamports row.
create table wager_ledger_entries (
  id              bigserial primary key,
  user_id         bigint not null references users(id),
  group_id        bigint references groups(id),      -- null for deposits/withdrawals
  market_id       uuid references markets(id),
  kind            text not null check (kind in
                  ('deposit', 'stake', 'payout', 'refund', 'withdrawal', 'withdrawal_refund')),
  lamports        bigint not null,                   -- signed lamports delta
  idempotency_key text not null unique,
  created_at      timestamptz not null default now()
);

create index wager_ledger_entries_user_idx on wager_ledger_entries (user_id);
create index wager_ledger_entries_market_idx on wager_ledger_entries (market_id);

-- One row per observed treasury-bound transfer INSTRUCTION: a single tx can
-- carry several system transfers (CLI/dapp batch), hence (tx_sig, ix_index).
create table wager_deposits (
  id            bigserial primary key,
  tx_sig        text not null,
  ix_index      int not null,
  sender_pubkey text not null,
  lamports      bigint not null,
  slot          bigint not null,
  user_id       bigint references users(id),  -- null = orphan (sender not linked yet)
  credited_at   timestamptz,                  -- null = not yet posted to the ledger
  observed_at   timestamptz not null default now(),
  unique (tx_sig, ix_index)
);

-- Orphan auto-credit at wallet verification time scans by sender.
create index wager_deposits_orphan_sender_idx on wager_deposits (sender_pubkey)
  where user_id is null;

-- Withdrawal outbox. The executor persists {tx_sig, raw_tx_b64,
-- last_valid_block_height} BEFORE broadcasting; identical bytes = identical
-- signature, so rebroadcast is always safe and crashes can never double-send.
create table wager_withdrawals (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 bigint not null references users(id),
  dest_pubkey             text not null,   -- copied from wager_wallet_links inside the RPC
  lamports                bigint not null,
  state                   text not null default 'debited'
                          check (state in ('debited', 'submitted', 'confirmed', 'failed')),
  tx_sig                  text,            -- deterministic pre-broadcast signature
  raw_tx_b64              text,            -- signed bytes, persisted before broadcast
  last_valid_block_height bigint,
  error                   text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index wager_withdrawals_state_idx on wager_withdrawals (state);

-- Money-movement marker for SOL settlements, deliberately separate from
-- settlements.posted_at (which tracks chat delivery only). The wager sweeper
-- re-runs applySettlement for settled/voided sol markets missing this row.
create table wager_settlements_applied (
  market_id  uuid primary key references markets(id),
  applied_at timestamptz not null default now()
);

-- Single-row PERSISTED circuit breaker: pausing survives crash loops (an
-- in-memory flag would re-arm stake acceptance while insolvent). Pausing
-- blocks NEW stakes only — settlement credits and withdrawals never pause.
create table wager_status (
  id         int primary key default 1 check (id = 1),
  paused     boolean not null default false,
  reason     text,
  updated_at timestamptz not null default now()
);

insert into wager_status (id, paused) values (1, false);

-- ── RLS: zero anon surface ─────────────────────────────────────────────────
-- RLS enabled with NO policies on purpose: anon/authenticated see nothing;
-- service_role (engine) bypasses RLS. Do NOT add these tables to
-- supabase_realtime and do NOT create views over them.
alter table wager_groups enable row level security;
alter table wager_wallet_links enable row level security;
alter table wager_ledger_entries enable row level security;
alter table wager_deposits enable row level security;
alter table wager_withdrawals enable row level security;
alter table wager_settlements_applied enable row level security;
alter table wager_status enable row level security;

-- ── Security-definer RPCs ──────────────────────────────────────────────────
-- supabase-js REST calls cannot express multi-statement transactions; these
-- functions give stake and withdrawal their atomicity. Both serialize all
-- money movement per user with pg_advisory_xact_lock, so concurrent taps and
-- rolling-deploy double-instances cannot overdraw a balance.
--
-- Constants are mirrored in apps/engine/src/wager/constants.ts and
-- packages/db/src/wager-db.ts; a parity test reads this file. Keep the
-- declaration lines below intact:
--   mult_scale                    = MULT_SCALE (1000)
--   per_market_stake_cap_lamports = PER_MARKET_STAKE_CAP_LAMPORTS
--   max_market_liability_lamports = MAX_MARKET_LIABILITY_LAMPORTS
--
-- Payout quantization (identical in SQL and JS):
--   mult_milli = round(multiplier * 1000)   -- float8 round, ties away from
--                                           -- zero == Math.round for m > 0
--   payout     = floor(stake * mult_milli / 1000)  -- bigint division

create or replace function wager_stake(
  p_user_id      bigint,
  p_group_id     bigint,
  p_market_id    uuid,
  p_side         text,
  p_lamports     bigint,
  p_multiplier   double precision,
  p_state        text,
  p_placed_at_ms bigint
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  mult_scale constant bigint := 1000;
  per_market_stake_cap_lamports constant bigint := 100000000;
  max_market_liability_lamports constant bigint := 2000000000;
  v_paused       boolean;
  v_balance      bigint;
  v_wrong_side   int;
  v_user_stakes  bigint;
  v_back_payout  bigint;
  v_doubt_payout bigint;
  v_total_stakes bigint;
  v_new_payout   bigint;
  v_worst        bigint;
  v_position_id  uuid;
begin
  -- Malformed calls are engine bugs, not user outcomes: raise, don't code.
  if p_lamports is null or p_lamports <= 0 then
    raise exception 'wager_stake: lamports must be positive, got %', p_lamports;
  end if;
  if p_side not in ('back', 'doubt') then
    raise exception 'wager_stake: invalid side %', p_side;
  end if;
  if p_state not in ('pending', 'active') then
    raise exception 'wager_stake: invalid state %', p_state;
  end if;

  -- Serialize all money movement for this user (stake vs stake, stake vs
  -- withdrawal) across every engine instance.
  perform pg_advisory_xact_lock(hashtextextended('wager:user:' || p_user_id::text, 0));

  select coalesce(sum(lamports), 0) into v_balance
  from wager_ledger_entries
  where user_id = p_user_id;
  if v_balance < p_lamports then
    return jsonb_build_object('ok', false, 'code', 'insufficient');
  end if;

  select
    count(*) filter (where user_id = p_user_id and side <> p_side),
    coalesce(sum(stake) filter (where user_id = p_user_id), 0),
    coalesce(sum((stake * round(locked_multiplier::float8 * mult_scale)::bigint) / mult_scale)
             filter (where side = 'back'), 0),
    coalesce(sum((stake * round(locked_multiplier::float8 * mult_scale)::bigint) / mult_scale)
             filter (where side = 'doubt'), 0),
    coalesce(sum(stake), 0)
  into v_wrong_side, v_user_stakes, v_back_payout, v_doubt_payout, v_total_stakes
  from positions
  where market_id = p_market_id and state <> 'void';

  if v_wrong_side > 0 then
    return jsonb_build_object('ok', false, 'code', 'wrong_side');
  end if;
  if v_user_stakes + p_lamports > per_market_stake_cap_lamports then
    return jsonb_build_object('ok', false, 'code', 'cap');
  end if;

  -- Worst-case treasury exposure if either side wins, including this stake:
  -- max over sides of sum(payout) minus sum(all stakes escrowed in the pool).
  v_new_payout := (p_lamports * round(p_multiplier * mult_scale)::bigint) / mult_scale;
  if p_side = 'back' then
    v_back_payout := v_back_payout + v_new_payout;
  else
    v_doubt_payout := v_doubt_payout + v_new_payout;
  end if;
  v_total_stakes := v_total_stakes + p_lamports;
  v_worst := greatest(v_back_payout, v_doubt_payout) - v_total_stakes;
  if v_worst > max_market_liability_lamports then
    return jsonb_build_object('ok', false, 'code', 'liability_cap');
  end if;

  select paused into v_paused from wager_status where id = 1;
  if v_paused is null then
    raise exception 'wager_stake: wager_status row missing';
  end if;
  if v_paused then
    return jsonb_build_object('ok', false, 'code', 'paused');
  end if;

  -- Positions are shared rows: the reducer's pending window, delay-snipe
  -- voids and activation apply to SOL positions with zero engine changes.
  insert into positions (market_id, user_id, side, stake, locked_multiplier, state, placed_at_ms)
  values (p_market_id, p_user_id, p_side, p_lamports, p_multiplier, p_state, p_placed_at_ms)
  returning id into v_position_id;

  insert into wager_ledger_entries (user_id, group_id, market_id, kind, lamports, idempotency_key)
  values (p_user_id, p_group_id, p_market_id, 'stake', -p_lamports, 'wager:stake:' || v_position_id);

  return jsonb_build_object('ok', true, 'position_id', v_position_id);
end;
$$;

create or replace function wager_request_withdrawal(
  p_user_id  bigint,
  p_lamports bigint
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dest    text;
  v_balance bigint;
  v_id      uuid;
begin
  if p_lamports is null or p_lamports <= 0 then
    raise exception 'wager_request_withdrawal: lamports must be positive, got %', p_lamports;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('wager:user:' || p_user_id::text, 0));

  -- Destination is ALWAYS the linked wallet — never caller-supplied.
  select pubkey into v_dest from wager_wallet_links where user_id = p_user_id;
  if v_dest is null then
    return jsonb_build_object('ok', false, 'code', 'no_wallet');
  end if;

  select coalesce(sum(lamports), 0) into v_balance
  from wager_ledger_entries
  where user_id = p_user_id;
  if v_balance < p_lamports then
    return jsonb_build_object('ok', false, 'code', 'insufficient');
  end if;

  -- Debit and outbox row land in the same transaction: a crash after commit
  -- leaves a 'debited' row the executor picks up; a crash before commit
  -- leaves nothing. No state where money moved without a record.
  insert into wager_withdrawals (user_id, dest_pubkey, lamports, state)
  values (p_user_id, v_dest, p_lamports, 'debited')
  returning id into v_id;

  insert into wager_ledger_entries (user_id, kind, lamports, idempotency_key)
  values (p_user_id, 'withdrawal', -p_lamports, 'wager:withdrawal:' || v_id);

  return jsonb_build_object('ok', true, 'withdrawal_id', v_id);
end;
$$;

-- PostgREST exposes public functions to anon by default; the wager RPCs are
-- strictly service_role-only.
revoke execute on function wager_stake(bigint, bigint, uuid, text, bigint, double precision, text, bigint)
  from public, anon, authenticated;
revoke execute on function wager_request_withdrawal(bigint, bigint)
  from public, anon, authenticated;
grant execute on function wager_stake(bigint, bigint, uuid, text, bigint, double precision, text, bigint)
  to service_role;
grant execute on function wager_request_withdrawal(bigint, bigint)
  to service_role;
