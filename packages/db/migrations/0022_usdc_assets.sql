-- Add Circle USDC alongside native SOL without changing historical balances.
-- Existing rows are SOL; all new financial rows carry an explicit asset.

alter table public.markets drop constraint if exists markets_currency_check;
alter table public.markets add constraint markets_currency_check
  check (currency in ('rep', 'sol', 'usdc'));

alter table public.wager_groups
  add column default_asset text not null default 'sol'
  check (default_asset in ('sol', 'usdc'));

alter table public.wager_ledger_entries
  add column asset text not null default 'sol'
  check (asset in ('sol', 'usdc'));
create index wager_ledger_entries_user_asset_idx
  on public.wager_ledger_entries (user_id, asset);

alter table public.wager_deposits
  add column asset text not null default 'sol'
  check (asset in ('sol', 'usdc')),
  add column mint_pubkey text;
create index wager_deposits_asset_sender_idx
  on public.wager_deposits (asset, sender_pubkey);

alter table public.wager_withdrawals
  add column asset text not null default 'sol'
  check (asset in ('sol', 'usdc'));
create index wager_withdrawals_user_asset_idx
  on public.wager_withdrawals (user_id, asset, state);

alter table public.wager_pending_stake_intents
  add column asset text not null default 'sol'
  check (asset in ('sol', 'usdc'));

create table public.wager_asset_status (
  asset      text primary key check (asset in ('sol', 'usdc')),
  paused     boolean not null default false,
  reason     text,
  updated_at timestamptz not null default now()
);

insert into public.wager_asset_status (asset, paused, reason)
select asset, s.paused, s.reason
from (values ('sol'::text), ('usdc'::text)) as a(asset)
cross join public.wager_status s
where s.id = 1;

alter table public.wager_asset_status enable row level security;
revoke all privileges on table public.wager_asset_status from public, anon, authenticated;
grant select, insert, update on table public.wager_asset_status to service_role;

-- Atomic stake commit. p_lamports is retained as a wire name for rolling
-- compatibility; for USDC it contains six-decimal token atomic units.
create or replace function public.wager_stake(
  p_user_id         bigint,
  p_group_id        bigint,
  p_market_id       uuid,
  p_side            text,
  p_lamports        bigint,
  p_multiplier      double precision,
  p_state           text,
  p_placed_at_ms    bigint,
  p_idempotency_key text,
  p_starter_only    boolean
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  starter_grant_lamports constant bigint := 10000000;
  v_balance      bigint;
  v_budget       wager_starter_budget%rowtype;
  v_cap          bigint;
  v_has_wallet   boolean;
  v_ledger_key   text;
  v_market       record;
  v_position_id  uuid;
  v_credit_id    bigint;
  v_paused       boolean;
  v_user_stakes  bigint;
  v_wrong_side   int;
begin
  if p_lamports is null or p_lamports <= 0 then
    raise exception 'wager_stake: amount must be positive, got %', p_lamports;
  end if;
  if p_side not in ('back', 'doubt') then
    return jsonb_build_object('ok', false, 'code', 'wrong_side');
  end if;
  if p_state not in ('pending', 'active') then
    return jsonb_build_object('ok', false, 'code', 'closed');
  end if;
  if p_starter_only is null then
    raise exception 'wager_stake: p_starter_only is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('wager:user:' || p_user_id::text, 0));

  v_ledger_key := case
    when p_idempotency_key is not null then 'wager:stake:api:' || p_idempotency_key
    else null
  end;
  if v_ledger_key is not null
     and exists (select 1 from wager_ledger_entries where idempotency_key = v_ledger_key) then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;

  select m.group_id, m.status, m.currency
  into v_market
  from markets m
  where m.id = p_market_id
  for update;
  if v_market is null
     or v_market.group_id <> p_group_id
     or v_market.currency not in ('sol', 'usdc')
     or v_market.status not in ('pending_lineup', 'open') then
    return jsonb_build_object('ok', false, 'code', 'closed');
  end if;
  if coalesce((select enabled from wager_groups where group_id = p_group_id), true) = false then
    return jsonb_build_object('ok', false, 'code', 'closed');
  end if;

  v_cap := case when v_market.currency = 'sol' then 100000000 else 10000000 end;
  select
    count(*) filter (where user_id = p_user_id and side <> p_side),
    coalesce(sum(stake) filter (where user_id = p_user_id), 0)
  into v_wrong_side, v_user_stakes
  from positions
  where market_id = p_market_id and state <> 'void';

  if v_wrong_side > 0 then
    return jsonb_build_object('ok', false, 'code', 'wrong_side');
  end if;
  if v_user_stakes + p_lamports > v_cap then
    return jsonb_build_object('ok', false, 'code', 'cap');
  end if;

  select paused into v_paused
  from wager_asset_status
  where asset = v_market.currency;
  if v_paused is null then
    raise exception 'wager_stake: wager_asset_status row missing for %', v_market.currency;
  end if;
  if v_paused then
    return jsonb_build_object('ok', false, 'code', 'paused');
  end if;

  if p_starter_only then
    if v_market.currency <> 'sol'
       or p_lamports <> starter_grant_lamports
       or exists (select 1 from wager_starter_grants where user_id = p_user_id) then
      return jsonb_build_object('ok', false, 'code', 'starter_unavailable');
    end if;

    select * into v_budget from wager_starter_budget where id = 1 for update;
    if v_budget.id is null then
      raise exception 'wager_stake: starter budget row missing';
    end if;
    if not v_budget.enabled then
      return jsonb_build_object('ok', false, 'code', 'starter_unavailable');
    end if;
    if v_budget.granted_count >= v_budget.max_grants
       or v_budget.granted_lamports + v_budget.grant_lamports > v_budget.total_cap_lamports then
      return jsonb_build_object('ok', false, 'code', 'budget_exhausted');
    end if;

    insert into positions (market_id, user_id, side, stake, locked_multiplier, state, placed_at_ms)
    values (p_market_id, p_user_id, p_side, p_lamports, p_multiplier, p_state, p_placed_at_ms)
    returning id into v_position_id;

    insert into wager_ledger_entries
      (user_id, group_id, market_id, kind, lamports, asset, idempotency_key)
    values
      (p_user_id, p_group_id, p_market_id, 'starter_grant', v_budget.grant_lamports,
       'sol', 'wager:starter:' || p_user_id::text)
    returning id into v_credit_id;

    insert into wager_ledger_entries
      (user_id, group_id, market_id, kind, lamports, asset, idempotency_key)
    values
      (p_user_id, p_group_id, p_market_id, 'stake', -p_lamports,
       'sol', coalesce(v_ledger_key, 'wager:stake:' || v_position_id));

    insert into wager_starter_grants (user_id, ledger_entry_id, position_id, lamports, idempotency_key)
    values (p_user_id, v_credit_id, v_position_id, v_budget.grant_lamports,
            'wager:starter:' || p_user_id::text);

    update wager_starter_budget
    set granted_count = granted_count + 1,
        granted_lamports = granted_lamports + grant_lamports,
        updated_at = now()
    where id = 1;

    return jsonb_build_object('ok', true, 'position_id', v_position_id);
  end if;

  select exists(select 1 from wager_wallet_links where user_id = p_user_id) into v_has_wallet;
  if not v_has_wallet then
    return jsonb_build_object('ok', false, 'code', 'wallet_required');
  end if;

  select coalesce(sum(lamports), 0) into v_balance
  from wager_ledger_entries
  where user_id = p_user_id and asset = v_market.currency;
  if v_balance < p_lamports then
    return jsonb_build_object('ok', false, 'code', 'insufficient');
  end if;

  insert into positions (market_id, user_id, side, stake, locked_multiplier, state, placed_at_ms)
  values (p_market_id, p_user_id, p_side, p_lamports, p_multiplier, p_state, p_placed_at_ms)
  returning id into v_position_id;

  insert into wager_ledger_entries
    (user_id, group_id, market_id, kind, lamports, asset, idempotency_key)
  values
    (p_user_id, p_group_id, p_market_id, 'stake', -p_lamports,
     v_market.currency, coalesce(v_ledger_key, 'wager:stake:' || v_position_id));

  return jsonb_build_object('ok', true, 'position_id', v_position_id);
end;
$$;

-- Asset-aware withdrawal RPC. The legacy two-argument SOL RPC remains during
-- rolling deploys; new callers must use this overload.
create function public.wager_request_withdrawal(
  p_user_id bigint,
  p_asset text,
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
  if p_asset not in ('sol', 'usdc') or p_lamports is null or p_lamports <= 0 then
    return jsonb_build_object('ok', false, 'code', 'invalid_asset');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('wager:user:' || p_user_id::text, 0));
  select pubkey into v_dest from wager_wallet_links where user_id = p_user_id;
  if v_dest is null then
    return jsonb_build_object('ok', false, 'code', 'no_wallet');
  end if;

  select coalesce(sum(lamports), 0) into v_balance
  from wager_ledger_entries
  where user_id = p_user_id and asset = p_asset;
  if v_balance < p_lamports then
    return jsonb_build_object('ok', false, 'code', 'insufficient');
  end if;

  insert into wager_withdrawals (user_id, dest_pubkey, lamports, asset, state)
  values (p_user_id, v_dest, p_lamports, p_asset, 'debited')
  returning id into v_id;

  insert into wager_ledger_entries (user_id, kind, lamports, asset, idempotency_key)
  values (p_user_id, 'withdrawal', -p_lamports, p_asset, 'wager:withdrawal:' || v_id);

  return jsonb_build_object('ok', true, 'withdrawal_id', v_id);
end;
$$;

revoke execute on function public.wager_request_withdrawal(bigint, text, bigint)
  from public, anon, authenticated;
grant execute on function public.wager_request_withdrawal(bigint, text, bigint)
  to service_role;

-- Pending confirmations derive their asset from the market; the client never
-- supplies a currency that could disagree with the call.
create or replace function public.wager_create_pending_stake_intent(
  p_user_id bigint,
  p_group_id bigint,
  p_market_id uuid,
  p_side text,
  p_lamports bigint,
  p_intent_key_hash_hex text,
  p_expires_at timestamptz
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_hash bytea := wager_decode_sha256_hex(p_intent_key_hash_hex);
  v_asset text;
  v_existing wager_pending_stake_intents%rowtype;
  v_active wager_pending_stake_intents%rowtype;
  v_id uuid;
begin
  select currency into v_asset from markets where id = p_market_id and group_id = p_group_id;
  if v_hash is null or p_side not in ('back', 'doubt') or p_lamports <= 0
     or v_asset not in ('sol', 'usdc') then
    return jsonb_build_object('ok', false, 'code', 'field_mismatch');
  end if;
  if p_expires_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'expired');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('intent:user:' || p_user_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('intent:key:' || encode(v_hash, 'hex'), 0));
  update wager_pending_stake_intents
  set state = 'expired', updated_at = now()
  where user_id = p_user_id and state in ('pending', 'awaiting_funds', 'ready') and expires_at <= now();
  select * into v_existing from wager_pending_stake_intents where intent_key_hash = v_hash;
  if v_existing.id is not null then
    if v_existing.user_id = p_user_id and v_existing.group_id = p_group_id
       and v_existing.market_id = p_market_id and v_existing.side = p_side
       and v_existing.lamports = p_lamports and v_existing.asset = v_asset then
      return jsonb_build_object('ok', true, 'intent_id', v_existing.id, 'state', v_existing.state);
    end if;
    return jsonb_build_object('ok', false, 'code', 'field_mismatch');
  end if;
  select * into v_active from wager_pending_stake_intents
  where user_id = p_user_id and state in ('pending', 'awaiting_funds', 'ready');
  if v_active.id is not null then
    return jsonb_build_object('ok', false, 'code', 'active_intent_exists', 'intent_id', v_active.id);
  end if;
  insert into wager_pending_stake_intents
    (user_id, group_id, market_id, side, lamports, asset, intent_key_hash, expires_at)
  values
    (p_user_id, p_group_id, p_market_id, p_side, p_lamports, v_asset, v_hash, p_expires_at)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'intent_id', v_id, 'state', 'pending');
exception
  when unique_violation then
    select * into v_existing from wager_pending_stake_intents where intent_key_hash = v_hash;
    if v_existing.id is not null
       and v_existing.user_id = p_user_id and v_existing.group_id = p_group_id
       and v_existing.market_id = p_market_id and v_existing.side = p_side
       and v_existing.lamports = p_lamports and v_existing.asset = v_asset then
      return jsonb_build_object('ok', true, 'intent_id', v_existing.id, 'state', v_existing.state);
    end if;
    return jsonb_build_object('ok', false, 'code', 'field_mismatch');
end;
$$;

create or replace function public.wager_resolve_active_stake_intent(p_user_id bigint) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_intent wager_pending_stake_intents%rowtype;
begin
  update wager_pending_stake_intents set state = 'expired', updated_at = now()
  where user_id = p_user_id and state in ('pending', 'awaiting_funds', 'ready') and expires_at <= now();
  select * into v_intent from wager_pending_stake_intents
  where user_id = p_user_id and state in ('pending', 'awaiting_funds', 'ready') and expires_at > now();
  if v_intent.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  return jsonb_build_object('ok', true, 'intent', jsonb_build_object(
    'id', v_intent.id, 'user_id', v_intent.user_id, 'group_id', v_intent.group_id,
    'market_id', v_intent.market_id, 'side', v_intent.side, 'lamports', v_intent.lamports,
    'asset', v_intent.asset, 'state', v_intent.state, 'expires_at', v_intent.expires_at,
    'created_at', v_intent.created_at, 'updated_at', v_intent.updated_at));
end;
$$;

create or replace function public.wager_consume_ready_stake_intent(
  p_user_id bigint,
  p_intent_id uuid
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_intent wager_pending_stake_intents%rowtype;
begin
  update wager_pending_stake_intents
  set state = 'consumed', consumed_at = now(), updated_at = now()
  where id = p_intent_id and user_id = p_user_id and state = 'ready' and expires_at > now()
  returning * into v_intent;
  if v_intent.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_ready');
  end if;
  return jsonb_build_object('ok', true, 'intent', jsonb_build_object(
    'id', v_intent.id, 'user_id', v_intent.user_id, 'group_id', v_intent.group_id,
    'market_id', v_intent.market_id, 'side', v_intent.side, 'lamports', v_intent.lamports,
    'asset', v_intent.asset, 'state', v_intent.state, 'expires_at', v_intent.expires_at,
    'created_at', v_intent.created_at, 'updated_at', v_intent.updated_at));
end;
$$;

-- Extend existing points and settlement orchestration to USDC while retaining
-- the exact locking, retry, and idempotency behavior from their source migrations.
do $$
declare
  v_definition text;
  v_function regprocedure;
begin
  select pg_get_functiondef('public.group_points_apply(uuid)'::regprocedure)
  into v_definition;
  if position('v_currency <> ''sol''' in v_definition) = 0 then
    raise exception 'group_points_apply SOL guard not found';
  end if;
  execute replace(
    v_definition,
    'v_currency <> ''sol''',
    'v_currency not in (''sol'', ''usdc'')'
  );

  v_function := to_regprocedure(
    'public.settlement_record_terminal(uuid,text,bigint,bigint[],text,timestamptz,integer,integer,integer,integer)'
  );
  if v_function is not null then
    select pg_get_functiondef(v_function) into v_definition;
    if position('v_market.currency <> ''sol''' in v_definition) = 0 then
      raise exception 'settlement_record_terminal SOL guard not found';
    end if;
    execute replace(
      v_definition,
      'v_market.currency <> ''sol''',
      'v_market.currency not in (''sol'', ''usdc'')'
    );
  end if;

  v_function := to_regprocedure(
    'public.settlement_proof_enqueue(uuid,text,timestamptz,timestamptz,integer,integer,integer,integer)'
  );
  if v_function is not null then
    select pg_get_functiondef(v_function) into v_definition;
    if position('v_market.currency <> ''sol''' in v_definition) = 0 then
      raise exception 'settlement_proof_enqueue SOL guard not found';
    end if;
    execute replace(
      v_definition,
      'v_market.currency <> ''sol''',
      'v_market.currency not in (''sol'', ''usdc'')'
    );
  end if;

  v_function := to_regprocedure('public.settlement_terminal_gaps(integer)');
  if v_function is not null then
    select pg_get_functiondef(v_function) into v_definition;
    if position('m.currency = ''sol''' in v_definition) = 0 then
      raise exception 'settlement_terminal_gaps SOL filter not found';
    end if;
    execute replace(
      v_definition,
      'm.currency = ''sol''',
      'm.currency in (''sol'', ''usdc'')'
    );
  end if;

  v_function := to_regprocedure(
    'public.settlement_reconcile_terminal_jobs(timestamptz,integer,integer,integer,integer,integer,integer)'
  );
  if v_function is not null then
    select pg_get_functiondef(v_function) into v_definition;
    if position('currency = ''sol''' in v_definition) = 0 then
      raise exception 'settlement_reconcile_terminal_jobs SOL filter not found';
    end if;
    execute replace(
      v_definition,
      'currency = ''sol''',
      'currency in (''sol'', ''usdc'')'
    );
  end if;
end;
$$;

-- Completed-match replays never move funds. Their fixed test stake only needs
-- to use the correct atomic-unit scale for the market asset.
create or replace function public.place_replay_position(
  p_user_id bigint,
  p_group_id bigint,
  p_market_id uuid,
  p_side text,
  p_stake bigint,
  p_multiplier double precision,
  p_state text,
  p_placed_at_ms bigint
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_market public.markets%rowtype;
  v_position_id uuid;
  v_expected_stake bigint;
begin
  if p_side not in ('back', 'doubt') then
    return jsonb_build_object('ok', false, 'code', 'wrong_side');
  end if;
  if p_state not in ('pending', 'active')
     or p_user_id is null
     or p_group_id is null
     or p_market_id is null
     or p_placed_at_ms is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('replay-position:' || p_market_id::text || ':' || p_user_id::text, 0)
  );

  select * into v_market
  from public.markets
  where id = p_market_id
  for update;

  if v_market.id is null
     or v_market.group_id <> p_group_id
     or not v_market.is_replay
     or v_market.currency not in ('sol', 'usdc') then
    return jsonb_build_object('ok', false, 'code', 'not_replay');
  end if;
  if v_market.status not in ('pending_lineup', 'open') then
    return jsonb_build_object('ok', false, 'code', 'closed');
  end if;

  v_expected_stake := case when v_market.currency = 'usdc' then 1000000 else 10000000 end;
  if p_stake <> v_expected_stake then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;

  if exists (
    select 1 from public.positions
    where market_id = p_market_id and user_id = p_user_id
  ) then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;

  insert into public.positions (
    market_id,
    user_id,
    side,
    stake,
    locked_multiplier,
    locked_odds_message_id,
    locked_odds_ts,
    state,
    placed_at_ms
  ) values (
    p_market_id,
    p_user_id,
    p_side,
    p_stake,
    p_multiplier,
    v_market.odds_message_id,
    v_market.odds_ts,
    p_state,
    p_placed_at_ms
  ) returning id into v_position_id;

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'position_id', v_position_id
  );
end;
$$;

-- Public surfaces expose generic atomic-unit totals while retaining the old
-- SOL column aliases for one rolling-deploy window.
drop view if exists public.public_group_board;
drop view if exists public.public_receipts;

create view public.public_receipts as
with position_totals as (
  select p.market_id,
    coalesce(sum(p.stake) filter (where p.side = 'back'), 0)::bigint as back_pot_atomic,
    coalesce(sum(p.stake) filter (where p.side = 'doubt'), 0)::bigint as doubt_pot_atomic,
    coalesce(sum(p.stake) filter (where p.side = 'back' and p.state = 'active'), 0)::bigint as active_back_atomic,
    coalesce(sum(p.stake) filter (where p.side = 'doubt' and p.state = 'active'), 0)::bigint as active_doubt_atomic,
    count(*)::bigint as position_count
  from public.positions p group by p.market_id
), ledger_totals as (
  select l.market_id,
    coalesce(sum(l.lamports) filter (where l.kind = 'refund' and l.lamports > 0), 0)::bigint as refunded_amount_atomic,
    coalesce(sum(l.lamports) filter (where l.kind = 'payout' and l.lamports > 0), 0)::bigint as paid_amount_atomic
  from public.wager_ledger_entries l where l.market_id is not null group by l.market_id
)
select
  m.id as market_id, g.slug as group_slug, m.spec, m.status, m.price_provenance,
  m.quote_probability, m.quote_multiplier, m.currency,
  coalesce(pt.back_pot_atomic, 0)::bigint::text as back_pot_atomic,
  coalesce(pt.doubt_pot_atomic, 0)::bigint::text as doubt_pot_atomic,
  coalesce(mt.matched_back_atomic + mt.matched_doubt_atomic, 0)::bigint::text as matched_amount_atomic,
  coalesce(lt.refunded_amount_atomic, 0)::bigint::text as refunded_amount_atomic,
  coalesce(lt.paid_amount_atomic, 0)::bigint::text as paid_amount_atomic,
  coalesce(pt.back_pot_atomic, 0)::bigint::text as back_pot_lamports,
  coalesce(pt.doubt_pot_atomic, 0)::bigint::text as doubt_pot_lamports,
  coalesce(mt.matched_back_atomic + mt.matched_doubt_atomic, 0)::bigint::text as matched_amount_lamports,
  coalesce(lt.refunded_amount_atomic, 0)::bigint::text as refunded_amount_lamports,
  coalesce(lt.paid_amount_atomic, 0)::bigint::text as paid_amount_lamports,
  coalesce(pt.position_count, 0)::bigint as position_count,
  m.created_at, s.outcome, s.deciding_seq, s.evidence_seqs, s.tier, s.settled_at,
  pr.status as proof_status, pr.explorer_url, pr.validate_stat_tx, pr.merkle_proof,
  pr.stat_key, pr.seq as proof_seq
from public.markets m
join public.groups g on g.id = m.group_id
left join position_totals pt on pt.market_id = m.id
left join ledger_totals lt on lt.market_id = m.id
left join lateral (
  select greatest(round(((1 - m.quote_probability) / m.quote_probability) * 1000)::bigint, 1) as ratio_milli
) ratio on true
left join lateral (
  select least(coalesce(pt.active_back_atomic, 0),
    (coalesce(pt.active_doubt_atomic, 0) * 1000) / ratio.ratio_milli) as matched_back_atomic
) mb on true
left join lateral (
  select mb.matched_back_atomic,
    least(coalesce(pt.active_doubt_atomic, 0),
      (mb.matched_back_atomic * ratio.ratio_milli) / 1000) as matched_doubt_atomic
) mt on true
left join public.settlements s on s.market_id = m.id
left join lateral (
  select p.status, p.explorer_url, p.validate_stat_tx, p.merkle_proof, p.stat_key, p.seq
  from public.proofs p where p.market_id = m.id
  order by case p.status when 'verified' then 4 when 'pending' then 3 when 'failed' then 2
    when 'unavailable' then 1 else 0 end desc,
    case p.kind when 'stat' then 1 else 0 end desc, p.id asc limit 1
) pr on true
where g.web_enabled and m.currency in ('sol', 'usdc') and not m.is_replay;

create view public.public_group_board as
select market_id, group_slug, spec, status, price_provenance, quote_probability,
  quote_multiplier, currency, back_pot_atomic, doubt_pot_atomic, matched_amount_atomic,
  refunded_amount_atomic, paid_amount_atomic, back_pot_lamports, doubt_pot_lamports,
  matched_amount_lamports, refunded_amount_lamports, paid_amount_lamports,
  position_count, created_at, outcome, settled_at
from public.public_receipts;

create or replace function public.public_market_is_web_enabled(p_market_id uuid) returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from markets m join groups g on g.id = m.group_id
    where m.id = p_market_id and g.web_enabled
      and m.currency in ('sol', 'usdc') and not m.is_replay
  );
$$;

grant select on public.public_receipts, public.public_group_board to anon, authenticated;
