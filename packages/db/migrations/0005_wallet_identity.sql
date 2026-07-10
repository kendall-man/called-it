create table wager_wallet_reconciliation_items (
  id          bigserial primary key,
  kind        text not null check (kind in ('unverified_link', 'orphan_deposit')),
  user_id     bigint references users(id),
  pubkey      text,
  deposit_id  bigint references wager_deposits(id),
  reason      text not null,
  created_at  timestamptz not null default now(),
  resolved_at timestamptz
);

create table wager_wallet_challenges (
  id             uuid primary key default gen_random_uuid(),
  user_id        bigint not null references users(id),
  pubkey         text not null,
  challenge_hash bytea not null check (octet_length(challenge_hash) = 32),
  issued_at      timestamptz not null default now(),
  expires_at     timestamptz not null,
  consumed_at    timestamptz
);

create index wager_wallet_challenges_user_idx on wager_wallet_challenges (user_id, expires_at)
  where consumed_at is null;

create table wager_wallet_link_history (
  id           bigserial primary key,
  user_id      bigint not null references users(id),
  pubkey       text not null unique,
  challenge_id uuid references wager_wallet_challenges(id),
  verified_at  timestamptz not null default now()
);

insert into wager_wallet_reconciliation_items (kind, user_id, pubkey, reason)
select 'unverified_link', user_id, pubkey, 'pre_migration_unverified_link'
from wager_wallet_links
where verified_at is null;

insert into wager_wallet_reconciliation_items (kind, pubkey, deposit_id, reason)
select 'orphan_deposit', sender_pubkey, id, 'pre_migration_orphan_deposit'
from wager_deposits
where user_id is null;

delete from wager_wallet_links where verified_at is null;

insert into wager_wallet_link_history (user_id, pubkey, verified_at)
select user_id, pubkey, verified_at
from wager_wallet_links;

alter table wager_wallet_links add column link_history_id bigint unique references wager_wallet_link_history(id);

update wager_wallet_links l
set link_history_id = h.id
from wager_wallet_link_history h
where h.user_id = l.user_id and h.pubkey = l.pubkey;

create table wager_pending_stake_intents (
  id              uuid primary key default gen_random_uuid(),
  user_id         bigint not null references users(id),
  group_id        bigint not null references groups(id),
  market_id       uuid not null references markets(id),
  side            text not null check (side in ('back', 'doubt')),
  lamports        bigint not null check (lamports > 0),
  intent_key_hash bytea not null unique check (octet_length(intent_key_hash) = 32),
  state           text not null default 'pending'
                  check (state in ('pending', 'awaiting_funds', 'ready', 'consumed', 'expired', 'cancelled')),
  expires_at      timestamptz not null,
  funded_at       timestamptz,
  consumed_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index wager_pending_stake_intents_one_active_user
  on wager_pending_stake_intents (user_id)
  where state in ('pending', 'awaiting_funds', 'ready');

alter table wager_wallet_reconciliation_items enable row level security;
alter table wager_wallet_challenges enable row level security;
alter table wager_wallet_link_history enable row level security;
alter table wager_pending_stake_intents enable row level security;

create or replace function wager_decode_sha256_hex(p_hash text) returns bytea
language plpgsql
immutable
security definer
set search_path = public
as $$
begin
  if p_hash is null or lower(p_hash) !~ '^[0-9a-f]{64}$' then
    return null;
  end if;
  return decode(lower(p_hash), 'hex');
end;
$$;

create function wager_verify_wallet_link(p_challenge_id uuid, p_user_id bigint, p_pubkey text, p_challenge_hash_hex text) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_hash bytea := wager_decode_sha256_hex(p_challenge_hash_hex);
  v_current record;
  v_history_id bigint;
  v_relinked boolean := false;
begin
  if v_hash is null or p_pubkey is null or p_pubkey = '' then
    return jsonb_build_object('ok', false, 'code', 'challenge_invalid');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('wallet:user:' || p_user_id::text, 0));
  update wager_wallet_challenges
  set consumed_at = now()
  where id = p_challenge_id
    and user_id = p_user_id
    and pubkey = p_pubkey
    and challenge_hash = v_hash
    and consumed_at is null
    and expires_at > now();
  if not found then
    if exists (
      select 1 from wager_wallet_challenges
      where id = p_challenge_id and user_id = p_user_id and pubkey = p_pubkey
        and challenge_hash = v_hash and consumed_at is null and expires_at <= now()
    ) then
      return jsonb_build_object('ok', false, 'code', 'challenge_expired');
    end if;
    return jsonb_build_object('ok', false, 'code', 'challenge_invalid');
  end if;
  if exists (select 1 from wager_wallet_link_history where pubkey = p_pubkey and user_id <> p_user_id) then
    return jsonb_build_object('ok', false, 'code', 'pubkey_reserved');
  end if;
  select * into v_current from wager_wallet_links where user_id = p_user_id for update;
  if v_current.user_id is not null and v_current.pubkey <> p_pubkey then
    if coalesce((select sum(lamports) from wager_ledger_entries where user_id = p_user_id), 0) <> 0 then
      return jsonb_build_object('ok', false, 'code', 'balance_nonzero');
    end if;
    if exists (select 1 from positions where user_id = p_user_id and state <> 'void') then
      return jsonb_build_object('ok', false, 'code', 'positions_open');
    end if;
    if exists (select 1 from wager_withdrawals where user_id = p_user_id and state in ('debited', 'submitted')) then
      return jsonb_build_object('ok', false, 'code', 'withdrawal_pending');
    end if;
    v_relinked := true;
  end if;
  select id into v_history_id from wager_wallet_link_history where pubkey = p_pubkey;
  if v_history_id is null then
    insert into wager_wallet_link_history (user_id, pubkey, challenge_id)
    values (p_user_id, p_pubkey, p_challenge_id)
    returning id into v_history_id;
  end if;
  insert into wager_wallet_links (user_id, pubkey, verified_at, link_history_id)
  values (p_user_id, p_pubkey, now(), v_history_id)
  on conflict (user_id) do update
    set pubkey = excluded.pubkey,
        verified_at = excluded.verified_at,
        link_history_id = excluded.link_history_id;
  return jsonb_build_object('ok', true, 'relinked', v_relinked, 'link_id', v_history_id);
end;
$$;

create function wager_create_pending_stake_intent(p_user_id bigint, p_group_id bigint, p_market_id uuid, p_side text, p_lamports bigint, p_intent_key_hash_hex text, p_expires_at timestamptz) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_hash bytea := wager_decode_sha256_hex(p_intent_key_hash_hex);
  v_existing wager_pending_stake_intents%rowtype;
  v_active wager_pending_stake_intents%rowtype;
  v_id uuid;
begin
  if v_hash is null or p_side not in ('back', 'doubt') or p_lamports <= 0 then
    return jsonb_build_object('ok', false, 'code', 'field_mismatch');
  end if;
  if p_expires_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'expired');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('intent:user:' || p_user_id::text, 0));
  update wager_pending_stake_intents
  set state = 'expired', updated_at = now()
  where user_id = p_user_id and state in ('pending', 'awaiting_funds', 'ready') and expires_at <= now();
  select * into v_existing from wager_pending_stake_intents where intent_key_hash = v_hash;
  if v_existing.id is not null then
    if v_existing.user_id = p_user_id and v_existing.group_id = p_group_id
       and v_existing.market_id = p_market_id and v_existing.side = p_side
       and v_existing.lamports = p_lamports then
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
    (user_id, group_id, market_id, side, lamports, intent_key_hash, expires_at)
  values
    (p_user_id, p_group_id, p_market_id, p_side, p_lamports, v_hash, p_expires_at)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'intent_id', v_id, 'state', 'pending');
end;
$$;

create function wager_resolve_active_stake_intent(p_user_id bigint) returns jsonb
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
    'state', v_intent.state, 'expires_at', v_intent.expires_at,
    'created_at', v_intent.created_at, 'updated_at', v_intent.updated_at));
end;
$$;

create function wager_mark_stake_intent_funded(p_user_id bigint, p_intent_id uuid) returns jsonb
language plpgsql security definer set search_path = public
as $$
begin
  update wager_pending_stake_intents
  set state = 'ready', funded_at = now(), updated_at = now()
  where id = p_intent_id and user_id = p_user_id and state in ('pending', 'awaiting_funds') and expires_at > now();
  return case when found then jsonb_build_object('ok', true) else jsonb_build_object('ok', false, 'code', 'not_ready') end;
end;
$$;

create function wager_consume_ready_stake_intent(p_user_id bigint, p_intent_id uuid) returns jsonb
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
    'state', v_intent.state, 'expires_at', v_intent.expires_at,
    'created_at', v_intent.created_at, 'updated_at', v_intent.updated_at));
end;
$$;

create function wager_cancel_stake_intent(p_user_id bigint, p_intent_id uuid) returns jsonb
language plpgsql security definer set search_path = public
as $$
begin
  update wager_pending_stake_intents
  set state = 'cancelled', updated_at = now()
  where id = p_intent_id and user_id = p_user_id and state in ('pending', 'awaiting_funds', 'ready');
  return case when found then jsonb_build_object('ok', true) else jsonb_build_object('ok', false, 'code', 'not_found') end;
end;
$$;

revoke execute on function wager_decode_sha256_hex(text), wager_verify_wallet_link(uuid, bigint, text, text), wager_create_pending_stake_intent(bigint, bigint, uuid, text, bigint, text, timestamptz), wager_resolve_active_stake_intent(bigint), wager_mark_stake_intent_funded(bigint, uuid), wager_consume_ready_stake_intent(bigint, uuid), wager_cancel_stake_intent(bigint, uuid) from public, anon, authenticated;
grant execute on function wager_decode_sha256_hex(text), wager_verify_wallet_link(uuid, bigint, text, text), wager_create_pending_stake_intent(bigint, bigint, uuid, text, bigint, text, timestamptz), wager_resolve_active_stake_intent(bigint), wager_mark_stake_intent_funded(bigint, uuid), wager_consume_ready_stake_intent(bigint, uuid), wager_cancel_stake_intent(bigint, uuid) to service_role;
