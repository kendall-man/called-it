-- Called It -- wager money-path hardening.
--
-- This migration makes deposit attribution a single atomic decision, keeps
-- unattributed transfers permanently private, serializes relinks with
-- withdrawal reservations, and exposes a read-only coverage snapshot for the
-- engine's persisted solvency breaker.

-- A transfer is either credited exactly once, rejected as dust, or made a
-- permanent orphan. Existing null-owner rows predate verified-wallet
-- attribution and are therefore legacy reconciliation items, never candidates
-- for a later automatic credit.
alter table wager_deposits
  add column attribution_state text not null default 'unattributed'
  check (attribution_state in ('unattributed', 'credited', 'orphaned', 'dust')),
  add column attribution_reason text;

update wager_deposits
set attribution_state = 'credited'
where user_id is not null or credited_at is not null;

update wager_deposits
set attribution_state = 'orphaned',
    attribution_reason = 'legacy_orphan'
where user_id is null and attribution_state = 'unattributed';

create index wager_deposits_orphaned_idx
  on wager_deposits (attribution_state, observed_at)
  where attribution_state = 'orphaned';

create unique index wager_wallet_reconciliation_deposit_unique
  on wager_wallet_reconciliation_items (deposit_id)
  where deposit_id is not null;

-- Atomically attribute one observed transfer. The pubkey lock matches wallet
-- verification's lock order at its shared point: a verification either commits
-- before this decision (so the transfer is current and verified) or after it
-- (so the transfer is permanently orphaned). There is no later auto-attach.
create function wager_credit_deposit(
  p_tx_sig       text,
  p_ix_index     integer,
  p_min_lamports bigint
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deposit      wager_deposits%rowtype;
  v_user_id      bigint;
  v_ledger_user  bigint;
  v_inserted     boolean := false;
  v_reason       text;
begin
  if p_tx_sig is null or btrim(p_tx_sig) = '' or p_ix_index is null or p_ix_index < 0
     or p_min_lamports is null or p_min_lamports <= 0 then
    raise exception 'wager_credit_deposit: invalid transfer identity or minimum';
  end if;

  select * into v_deposit
  from wager_deposits
  where tx_sig = p_tx_sig and ix_index = p_ix_index
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  if v_deposit.attribution_state = 'credited' then
    return jsonb_build_object('ok', true, 'outcome', 'already_credited', 'user_id', v_deposit.user_id);
  end if;
  if v_deposit.attribution_state = 'orphaned' then
    return jsonb_build_object(
      'ok', false,
      'code', coalesce(v_deposit.attribution_reason, 'orphaned')
    );
  end if;
  if v_deposit.attribution_state = 'dust' then
    return jsonb_build_object('ok', false, 'code', 'below_minimum');
  end if;

  if v_deposit.lamports < p_min_lamports then
    update wager_deposits
    set attribution_state = 'dust', attribution_reason = 'below_minimum'
    where id = v_deposit.id;
    return jsonb_build_object('ok', false, 'code', 'below_minimum');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('wallet:pubkey:' || v_deposit.sender_pubkey, 0)
  );

  select user_id into v_user_id
  from wager_wallet_links
  where pubkey = v_deposit.sender_pubkey
    and verified_at is not null
    and link_history_id is not null;

  if v_user_id is null then
    if exists (
      select 1 from wager_wallet_link_history where pubkey = v_deposit.sender_pubkey
    ) then
      v_reason := 'stale_wallet';
    elsif exists (
      select 1
      from wager_wallet_links
      where pubkey = v_deposit.sender_pubkey and verified_at is null
    ) then
      v_reason := 'unverified_wallet';
    else
      v_reason := 'unlinked_sender';
    end if;

    update wager_deposits
    set attribution_state = 'orphaned', attribution_reason = v_reason
    where id = v_deposit.id;

    insert into wager_wallet_reconciliation_items (kind, pubkey, deposit_id, reason)
    values ('orphan_deposit', v_deposit.sender_pubkey, v_deposit.id, v_reason)
    on conflict (deposit_id) where deposit_id is not null do nothing;

    return jsonb_build_object('ok', false, 'code', v_reason);
  end if;

  insert into wager_ledger_entries (user_id, kind, lamports, idempotency_key)
  values (
    v_user_id,
    'deposit',
    v_deposit.lamports,
    'wager:deposit:' || v_deposit.tx_sig || ':' || v_deposit.ix_index::text
  )
  on conflict (idempotency_key) do nothing
  returning user_id into v_ledger_user;
  v_inserted := found;

  if not v_inserted then
    select user_id into v_ledger_user
    from wager_ledger_entries
    where idempotency_key = 'wager:deposit:' || v_deposit.tx_sig || ':' || v_deposit.ix_index::text;
    if v_ledger_user is distinct from v_user_id then
      raise exception 'wager_credit_deposit: conflicting ledger owner for %, %', p_tx_sig, p_ix_index;
    end if;
  end if;

  update wager_deposits
  set user_id = v_user_id,
      credited_at = now(),
      attribution_state = 'credited',
      attribution_reason = null
  where id = v_deposit.id;

  return jsonb_build_object(
    'ok', true,
    'outcome', case when v_inserted then 'credited' else 'already_credited' end,
    'user_id', v_user_id
  );
end;
$$;

-- The complete liability snapshot is one database statement so each component
-- comes from the same MVCC view. Positive user balances are summed separately:
-- a corrupt negative balance must never reduce another user's coverage.
create function wager_solvency_snapshot() returns jsonb
language sql
security definer
set search_path = public
as $$
  with positive_balances as (
    select coalesce(sum(greatest(balance_lamports, 0)), 0)::bigint as lamports
    from (
      select user_id, coalesce(sum(lamports), 0)::bigint as balance_lamports
      from wager_ledger_entries
      group by user_id
    ) balances
  ), open_escrow as (
    select coalesce(sum(p.stake), 0)::bigint as lamports
    from positions p
    join markets m on m.id = p.market_id
    where m.currency = 'sol'
      and m.status in ('pending_lineup', 'open', 'frozen', 'settling')
      and p.state <> 'void'
  ), pending_withdrawals as (
    select coalesce(sum(lamports), 0)::bigint as lamports
    from wager_withdrawals
    where state in ('debited', 'submitted')
  ), starter_reserve as (
    select coalesce(
      max(case when enabled then total_cap_lamports - granted_lamports else 0 end),
      0
    )::bigint as lamports
    from wager_starter_budget
    where id = 1
  )
  select jsonb_build_object(
    'positive_ledger_lamports', (select lamports from positive_balances),
    'open_escrow_lamports', (select lamports from open_escrow),
    'pending_withdrawal_lamports', (select lamports from pending_withdrawals),
    'remaining_starter_cap_lamports', (select lamports from starter_reserve)
  );
$$;

-- Only a solvency-created pause may be changed by the monitor. Manual pauses
-- remain authoritative even while the treasury has recovered.
create function wager_set_solvency_status(
  p_paused boolean,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status wager_status%rowtype;
begin
  if p_paused and (p_reason is null or p_reason not like 'solvency:%') then
    raise exception 'wager_set_solvency_status: pause reason must use solvency prefix';
  end if;
  if not p_paused and p_reason is not null then
    raise exception 'wager_set_solvency_status: recovery reason must be null';
  end if;

  select * into v_status from wager_status where id = 1 for update;
  if not found then
    raise exception 'wager_set_solvency_status: wager_status row missing';
  end if;

  if p_paused then
    if v_status.paused and coalesce(v_status.reason, '') not like 'solvency:%' then
      return jsonb_build_object('ok', true, 'changed', false, 'manual_pause', true);
    end if;
    update wager_status set paused = true, reason = p_reason, updated_at = now() where id = 1;
    return jsonb_build_object('ok', true, 'changed', true, 'manual_pause', false);
  end if;

  if v_status.paused and coalesce(v_status.reason, '') like 'solvency:%' then
    update wager_status set paused = false, reason = null, updated_at = now() where id = 1;
    return jsonb_build_object('ok', true, 'changed', true, 'manual_pause', false);
  end if;
  return jsonb_build_object('ok', true, 'changed', false, 'manual_pause', false);
end;
$$;

-- Dry-run reconciliation output only: no identifiers, wallet material, or
-- mutations leave this function. Operations can use the stable reason counts
-- to plan an explicit manual review without creating an auto-claim path.
create function wager_classify_legacy_reconciliation() returns jsonb
language sql
security definer
set search_path = public
as $$
  with unresolved as (
    select kind, reason, count(*)::integer as count
    from wager_wallet_reconciliation_items
    where resolved_at is null
    group by kind, reason
  )
  select jsonb_build_object(
    'unresolved_count', coalesce((select sum(count) from unresolved), 0),
    'unverified_link_count', coalesce((select sum(count) from unresolved where kind = 'unverified_link'), 0),
    'orphan_deposit_count', coalesce((select sum(count) from unresolved where kind = 'orphan_deposit'), 0),
    'reasons', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object('kind', kind, 'reason', reason, 'count', count)
          order by kind, reason
        )
        from unresolved
      ),
      '[]'::jsonb
    )
  );
$$;

-- Withdrawal reservation and wallet replacement serialize on the same user
-- key. A reservation always copies a verified *current* destination and makes
-- exactly one outstanding outbox row before the balance debit is committed.
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

  perform pg_advisory_xact_lock(hashtextextended('wallet:user:' || p_user_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('wager:user:' || p_user_id::text, 0));

  select pubkey into v_dest
  from wager_wallet_links
  where user_id = p_user_id
    and verified_at is not null
    and link_history_id is not null;
  if v_dest is null then
    if exists (select 1 from wager_wallet_links where user_id = p_user_id) then
      return jsonb_build_object('ok', false, 'code', 'wallet_unverified');
    end if;
    return jsonb_build_object('ok', false, 'code', 'no_wallet');
  end if;

  if exists (
    select 1
    from wager_withdrawals
    where user_id = p_user_id and state in ('debited', 'submitted')
  ) then
    return jsonb_build_object('ok', false, 'code', 'withdrawal_pending');
  end if;

  select coalesce(sum(lamports), 0) into v_balance
  from wager_ledger_entries
  where user_id = p_user_id;
  if v_balance < p_lamports then
    return jsonb_build_object('ok', false, 'code', 'insufficient');
  end if;

  insert into wager_withdrawals (user_id, dest_pubkey, lamports, state)
  values (p_user_id, v_dest, p_lamports, 'debited')
  returning id into v_id;

  insert into wager_ledger_entries (user_id, kind, lamports, idempotency_key)
  values (p_user_id, 'withdrawal', -p_lamports, 'wager:withdrawal:' || v_id);

  return jsonb_build_object('ok', true, 'withdrawal_id', v_id);
end;
$$;

-- Relinking shares the wallet and money locks with withdrawal reservation.
-- That prevents a verified replacement from racing a balance credit, stake, or
-- newly reserved withdrawal between its blocker checks and the link update.
create or replace function wager_verify_wallet_link(
  p_challenge_id uuid,
  p_user_id bigint,
  p_pubkey text,
  p_challenge_hash_hex text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash bytea := wager_decode_sha256_hex(p_challenge_hash_hex);
  v_current record;
  v_history_id bigint;
  v_history_user_id bigint;
  v_relinked boolean := false;
begin
  if v_hash is null or p_pubkey is null or p_pubkey = '' then
    return jsonb_build_object('ok', false, 'code', 'challenge_invalid');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('wallet:user:' || p_user_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('wager:user:' || p_user_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('wallet:pubkey:' || p_pubkey, 0));

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

  if exists (
    select 1 from wager_wallet_link_history where pubkey = p_pubkey and user_id <> p_user_id
  ) then
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
    if exists (
      select 1 from wager_withdrawals where user_id = p_user_id and state in ('debited', 'submitted')
    ) then
      return jsonb_build_object('ok', false, 'code', 'withdrawal_pending');
    end if;
    v_relinked := true;
  end if;

  select id, user_id into v_history_id, v_history_user_id
  from wager_wallet_link_history
  where pubkey = p_pubkey;
  if v_history_id is not null and v_history_user_id <> p_user_id then
    return jsonb_build_object('ok', false, 'code', 'pubkey_reserved');
  end if;
  if v_history_id is null then
    begin
      insert into wager_wallet_link_history (user_id, pubkey, challenge_id)
      values (p_user_id, p_pubkey, p_challenge_id)
      returning id into v_history_id;
    exception
      when unique_violation then
        select id, user_id into v_history_id, v_history_user_id
        from wager_wallet_link_history
        where pubkey = p_pubkey;
        if v_history_id is null then
          raise;
        end if;
        if v_history_user_id <> p_user_id then
          return jsonb_build_object('ok', false, 'code', 'pubkey_reserved');
        end if;
    end;
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

revoke execute on function
  wager_credit_deposit(text, integer, bigint),
  wager_solvency_snapshot(),
  wager_set_solvency_status(boolean, text),
  wager_classify_legacy_reconciliation(),
  wager_request_withdrawal(bigint, bigint),
  wager_verify_wallet_link(uuid, bigint, text, text)
from public, anon, authenticated;

grant execute on function
  wager_credit_deposit(text, integer, bigint),
  wager_solvency_snapshot(),
  wager_set_solvency_status(boolean, text),
  wager_classify_legacy_reconciliation(),
  wager_request_withdrawal(bigint, bigint),
  wager_verify_wallet_link(uuid, bigint, text, text)
to service_role;
