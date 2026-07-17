create table wager_starter_budget (
  id                  int primary key default 1 check (id = 1),
  enabled             boolean not null default false,
  grant_lamports      bigint not null default 10000000 check (grant_lamports = 10000000),
  total_cap_lamports  bigint not null default 5000000000 check (total_cap_lamports = 5000000000),
  max_grants          int not null default 500 check (max_grants = 500),
  granted_lamports    bigint not null default 0,
  granted_count       int not null default 0,
  updated_at          timestamptz not null default now(),
  check (granted_count >= 0),
  check (granted_lamports >= 0),
  check (granted_count <= max_grants),
  check (granted_lamports <= total_cap_lamports),
  check (granted_lamports = granted_count::bigint * grant_lamports)
);

insert into wager_starter_budget (id) values (1);

create table wager_starter_grants (
  user_id         bigint primary key references users(id),
  ledger_entry_id bigint not null unique references wager_ledger_entries(id),
  position_id     uuid not null unique references positions(id),
  lamports        bigint not null check (lamports = 10000000),
  idempotency_key text not null unique,
  granted_at      timestamptz not null default now()
);

alter table wager_starter_budget enable row level security;
alter table wager_starter_grants enable row level security;

alter table wager_ledger_entries drop constraint wager_ledger_entries_kind_check;
alter table wager_ledger_entries add constraint wager_ledger_entries_kind_check check (
  kind in ('deposit', 'starter_grant', 'stake', 'payout', 'refund', 'withdrawal', 'withdrawal_refund')
);

drop function if exists wager_stake(bigint, bigint, uuid, text, bigint, double precision, text, bigint, text);

create function wager_stake(
  p_user_id         bigint,
  p_group_id        bigint,
  p_market_id       uuid,
  p_side            text,
  p_lamports        bigint,
  p_multiplier      double precision,
  p_state           text,
  p_placed_at_ms    bigint,
  p_idempotency_key text,
  p_allow_starter   boolean
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  starter_grant_lamports constant bigint := 10000000;
  per_market_stake_cap_lamports constant bigint := 100000000;
  v_balance      bigint;
  v_budget       wager_starter_budget%rowtype;
  v_can_starter  boolean;
  v_has_history  boolean;
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
    raise exception 'wager_stake: lamports must be positive, got %', p_lamports;
  end if;
  if p_side not in ('back', 'doubt') then
    return jsonb_build_object('ok', false, 'code', 'wrong_side');
  end if;
  if p_state not in ('pending', 'active') then
    return jsonb_build_object('ok', false, 'code', 'closed');
  end if;
  if p_allow_starter is null then
    raise exception 'wager_stake: p_allow_starter is required';
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
  where m.id = p_market_id;
  if v_market is null
     or v_market.group_id <> p_group_id
     or v_market.currency <> 'sol'
     or v_market.status not in ('pending_lineup', 'open') then
    return jsonb_build_object('ok', false, 'code', 'closed');
  end if;
  if not coalesce((select enabled from wager_groups where group_id = p_group_id), false) then
    return jsonb_build_object('ok', false, 'code', 'closed');
  end if;

  select
    count(*) filter (where user_id = p_user_id and side <> p_side),
    coalesce(sum(stake) filter (where user_id = p_user_id), 0)
  into v_wrong_side, v_user_stakes
  from positions
  where market_id = p_market_id and state <> 'void';

  if v_wrong_side > 0 then
    return jsonb_build_object('ok', false, 'code', 'wrong_side');
  end if;
  if v_user_stakes + p_lamports > per_market_stake_cap_lamports then
    return jsonb_build_object('ok', false, 'code', 'cap');
  end if;

  select paused into v_paused from wager_status where id = 1;
  if v_paused is null then
    raise exception 'wager_stake: wager_status row missing';
  end if;
  if v_paused then
    return jsonb_build_object('ok', false, 'code', 'paused');
  end if;

  v_has_history :=
    exists (select 1 from wager_ledger_entries where user_id = p_user_id)
    or exists (select 1 from positions where user_id = p_user_id)
    or exists (select 1 from wager_starter_grants where user_id = p_user_id);
  v_can_starter := p_allow_starter and p_lamports = starter_grant_lamports and not v_has_history;

  if v_can_starter then
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

    insert into wager_ledger_entries (user_id, group_id, market_id, kind, lamports, idempotency_key)
    values (p_user_id, p_group_id, p_market_id, 'starter_grant', v_budget.grant_lamports,
            'wager:starter:' || p_user_id::text)
    returning id into v_credit_id;

    insert into wager_ledger_entries (user_id, group_id, market_id, kind, lamports, idempotency_key)
    values (p_user_id, p_group_id, p_market_id, 'stake', -p_lamports,
            coalesce(v_ledger_key, 'wager:stake:' || v_position_id));

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
  where user_id = p_user_id;
  if v_balance < p_lamports then
    return jsonb_build_object('ok', false, 'code', 'insufficient');
  end if;

  insert into positions (market_id, user_id, side, stake, locked_multiplier, state, placed_at_ms)
  values (p_market_id, p_user_id, p_side, p_lamports, p_multiplier, p_state, p_placed_at_ms)
  returning id into v_position_id;

  insert into wager_ledger_entries (user_id, group_id, market_id, kind, lamports, idempotency_key)
  values (p_user_id, p_group_id, p_market_id, 'stake', -p_lamports,
          coalesce(v_ledger_key, 'wager:stake:' || v_position_id));

  return jsonb_build_object('ok', true, 'position_id', v_position_id);
end;
$$;

revoke execute on function
  wager_stake(bigint, bigint, uuid, text, bigint, double precision, text, bigint, text, boolean)
  from public, anon, authenticated;
grant execute on function
  wager_stake(bigint, bigint, uuid, text, bigint, double precision, text, bigint, text, boolean)
  to service_role;
