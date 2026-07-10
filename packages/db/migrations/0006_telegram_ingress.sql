create table telegram_updates (
  id                   uuid primary key default gen_random_uuid(),
  source_key           text not null unique
                       check (char_length(source_key) between 1 and 256),
  source_fingerprint   text not null unique
                       check (source_fingerprint ~ '^[A-Za-z0-9_-]{43}$'),
  telegram_update_id   bigint not null
                       check (telegram_update_id >= 0),
  update_type          text not null
                       check (update_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  payload              jsonb
                       check (
                         payload is null
                         or (
                           jsonb_typeof(payload) = 'object'
                           and octet_length(payload::text) <= 65536
                         )
                       ),
  routing_decision     text not null
                       check (routing_decision in ('pending_engine', 'routed_concierge')),
  state                text not null
                       check (state in ('pending_engine', 'routed_concierge', 'leased', 'retry_wait', 'completed', 'dead')),
  attempts             integer not null default 0
                       check (attempts >= 0),
  next_attempt_at      timestamptz not null default clock_timestamp(),
  lease_owner          uuid,
  lease_expires_at     timestamptz,
  last_error_code      text
                       check (last_error_code is null or last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  received_at          timestamptz not null default clock_timestamp(),
  updated_at           timestamptz not null default clock_timestamp(),
  leased_at            timestamptz,
  routed_at            timestamptz,
  completed_at         timestamptz,
  dead_at              timestamptz,
  payload_purged_at    timestamptz,
  check (
    (state = 'leased' and lease_owner is not null and lease_expires_at is not null)
    or (state <> 'leased' and lease_owner is null and lease_expires_at is null)
  ),
  check (
    (state = 'completed') = (completed_at is not null)
  ),
  check (
    (state = 'dead') = (dead_at is not null)
  ),
  check (
    (state = 'routed_concierge') = (routed_at is not null)
  ),
  check (
    (state <> 'completed' or dead_at is null)
    and (state <> 'completed' or routed_at is null)
    and (state <> 'dead' or completed_at is null)
    and (state <> 'dead' or routed_at is null)
    and (state <> 'routed_concierge' or completed_at is null)
    and (state <> 'routed_concierge' or dead_at is null)
  ),
  check (
    (routing_decision = 'routed_concierge' and state = 'routed_concierge')
    or (routing_decision = 'pending_engine' and state <> 'routed_concierge')
  ),
  check (
    state not in ('pending_engine', 'leased', 'retry_wait', 'dead')
    or payload is not null
  )
);

create index telegram_updates_ready_idx
  on telegram_updates (next_attempt_at, received_at, id)
  where state in ('pending_engine', 'retry_wait');

create index telegram_updates_expired_lease_idx
  on telegram_updates (lease_expires_at, id)
  where state = 'leased';

create index telegram_updates_completed_retention_idx
  on telegram_updates (completed_at)
  where completed_at is not null;

create index telegram_updates_routed_retention_idx
  on telegram_updates (routed_at)
  where routed_at is not null;

create index telegram_updates_dead_retention_idx
  on telegram_updates (dead_at)
  where dead_at is not null;

create table telegram_outbound_ownership_jobs (
  id                   uuid primary key default gen_random_uuid(),
  logical_key          text not null unique
                       check (char_length(logical_key) between 1 and 256),
  chat_id              bigint not null,
  domain_kind          text not null
                       check (domain_kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  domain_id            text not null
                       check (char_length(domain_id) between 1 and 256),
  state                text not null
                       check (state in ('planned', 'sending', 'owned', 'complete', 'ownership_uncertain', 'reconciled', 'manual_review')),
  send_attempts        integer not null default 0
                       check (send_attempts >= 0),
  reconcile_attempts   integer not null default 0
                       check (reconcile_attempts >= 0),
  next_attempt_at      timestamptz not null default clock_timestamp(),
  lease_owner          uuid,
  lease_expires_at     timestamptz,
  telegram_message_id  bigint
                       check (telegram_message_id is null or telegram_message_id > 0),
  last_error_code      text
                       check (last_error_code is null or last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  planned_at           timestamptz not null default clock_timestamp(),
  updated_at           timestamptz not null default clock_timestamp(),
  sending_at           timestamptz,
  owned_at             timestamptz,
  completed_at         timestamptz,
  uncertain_at         timestamptz,
  reconciled_at        timestamptz,
  manual_review_at     timestamptz,
  check (
    (lease_owner is null and lease_expires_at is null)
    or (lease_owner is not null and lease_expires_at is not null)
  ),
  check (
    (state = 'planned')
    = (
      send_attempts = 0
      and sending_at is null
      and owned_at is null
      and completed_at is null
      and uncertain_at is null
      and reconciled_at is null
      and manual_review_at is null
      and lease_owner is null
      and lease_expires_at is null
      and telegram_message_id is null
    )
  ),
  check (
    state <> 'sending'
    or (
      send_attempts = 1
      and sending_at is not null
      and owned_at is null
      and completed_at is null
      and uncertain_at is null
      and reconciled_at is null
      and manual_review_at is null
      and lease_owner is not null
      and lease_expires_at is not null
      and telegram_message_id is null
    )
  ),
  check (
    state <> 'owned'
    or (
      send_attempts = 1
      and sending_at is not null
      and owned_at is not null
      and completed_at is null
      and uncertain_at is null
      and reconciled_at is null
      and manual_review_at is null
      and telegram_message_id is not null
    )
  ),
  check (
    state <> 'complete'
    or (
      send_attempts = 1
      and sending_at is not null
      and completed_at is not null
      and manual_review_at is null
      and lease_owner is null
      and lease_expires_at is null
      and telegram_message_id is not null
      and (
        (
          owned_at is not null
          and uncertain_at is null
          and reconciled_at is null
        )
        or (
          owned_at is null
          and uncertain_at is not null
          and reconciled_at is not null
        )
      )
    )
  ),
  check (
    state <> 'ownership_uncertain'
    or (
      send_attempts = 1
      and sending_at is not null
      and owned_at is null
      and completed_at is null
      and uncertain_at is not null
      and reconciled_at is null
      and manual_review_at is null
      and telegram_message_id is null
    )
  ),
  check (
    state <> 'reconciled'
    or (
      send_attempts = 1
      and sending_at is not null
      and owned_at is null
      and completed_at is null
      and uncertain_at is not null
      and reconciled_at is not null
      and manual_review_at is null
      and telegram_message_id is not null
    )
  ),
  check (
    state <> 'manual_review'
    or (
      send_attempts = 1
      and sending_at is not null
      and owned_at is null
      and completed_at is null
      and uncertain_at is not null
      and reconciled_at is null
      and manual_review_at is not null
      and lease_owner is null
      and lease_expires_at is null
      and telegram_message_id is null
    )
  )
);

create index telegram_outbound_jobs_expired_send_idx
  on telegram_outbound_ownership_jobs (lease_expires_at, id)
  where state = 'sending';

create index telegram_outbound_jobs_expired_completion_idx
  on telegram_outbound_ownership_jobs (lease_expires_at, id)
  where state in ('owned', 'reconciled');

create index telegram_outbound_jobs_reconcile_ready_idx
  on telegram_outbound_ownership_jobs (next_attempt_at, uncertain_at, id)
  where state = 'ownership_uncertain';

create index telegram_outbound_jobs_completed_retention_idx
  on telegram_outbound_ownership_jobs (completed_at)
  where completed_at is not null;

create index telegram_outbound_jobs_manual_retention_idx
  on telegram_outbound_ownership_jobs (manual_review_at)
  where manual_review_at is not null;

create table engine_owned_messages (
  chat_id            bigint not null,
  message_id         bigint not null check (message_id > 0),
  outbound_job_id    uuid not null unique
                     references telegram_outbound_ownership_jobs(id) on delete cascade,
  ownership_source   text not null
                     check (ownership_source in ('live', 'reconciled')),
  owned_at           timestamptz not null default clock_timestamp(),
  primary key (chat_id, message_id)
);

create table engine_worker_heartbeats (
  worker_kind    text not null
                 check (worker_kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  worker_id      uuid not null,
  started_at     timestamptz not null,
  heartbeat_at   timestamptz not null,
  stopping_at    timestamptz,
  primary key (worker_kind, worker_id)
);

alter table telegram_updates enable row level security;
alter table telegram_outbound_ownership_jobs enable row level security;
alter table engine_owned_messages enable row level security;
alter table engine_worker_heartbeats enable row level security;

revoke all on table telegram_updates from public, anon, authenticated;
revoke all on table telegram_outbound_ownership_jobs from public, anon, authenticated;
revoke all on table engine_owned_messages from public, anon, authenticated;
revoke all on table engine_worker_heartbeats from public, anon, authenticated;

create function telegram_is_bounded_code(p_value text) returns boolean
language sql
immutable
set search_path = public
as $$
  select p_value is not null and p_value ~ '^[a-z][a-z0-9_]{0,63}$'
$$;

create function telegram_is_source_fingerprint(p_value text) returns boolean
language sql
immutable
set search_path = public
as $$
  select p_value is not null and p_value ~ '^[A-Za-z0-9_-]{43}$'
$$;

create function telegram_persist_update(
  p_source_key text,
  p_source_fingerprint text,
  p_telegram_update_id bigint,
  p_update_type text,
  p_payload jsonb,
  p_routing_decision text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row telegram_updates%rowtype;
  v_state text;
begin
  if p_source_key is null or char_length(p_source_key) not between 1 and 256 then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;
  if not telegram_is_source_fingerprint(p_source_fingerprint) then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;
  if p_telegram_update_id is null or p_telegram_update_id < 0 then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;
  if not telegram_is_bounded_code(p_update_type) then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text) > 65536 then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;
  if p_routing_decision is null or p_routing_decision not in ('pending_engine', 'routed_concierge') then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;

  v_state := case
    when p_routing_decision = 'pending_engine' then 'pending_engine'
    else 'routed_concierge'
  end;

  begin
    insert into telegram_updates (
      source_key,
      source_fingerprint,
      telegram_update_id,
      update_type,
      payload,
      routing_decision,
      state,
      next_attempt_at,
      routed_at,
      received_at,
      updated_at
    )
    values (
      p_source_key,
      p_source_fingerprint,
      p_telegram_update_id,
      p_update_type,
      p_payload,
      p_routing_decision,
      v_state,
      v_now,
      case when v_state = 'routed_concierge' then v_now else null end,
      v_now,
      v_now
    )
    returning * into v_row;
  exception
    when unique_violation then
      select *
      into v_row
      from telegram_updates
      where source_key = p_source_key;

      if v_row.id is not null then
        return jsonb_build_object(
          'ok', true,
          'id', v_row.id,
          'routing_decision', v_row.routing_decision,
          'state', v_row.state,
          'duplicate', true
        );
      end if;

      if exists (
        select 1
        from telegram_updates
        where source_fingerprint = p_source_fingerprint
      ) then
        return jsonb_build_object('ok', false, 'code', 'source_conflict');
      end if;

      raise;
  end;

  return jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'routing_decision', v_row.routing_decision,
    'state', v_row.state,
    'duplicate', false
  );
end;
$$;

create function telegram_lease_updates(
  p_worker_id uuid,
  p_limit integer,
  p_lease_ms integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_lease_expires timestamptz;
  v_items jsonb;
begin
  if p_worker_id is null or p_limit is null or p_lease_ms is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;
  if p_limit < 1 or p_limit > 100 or p_lease_ms < 1 or p_lease_ms > 86400000 then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;

  v_lease_expires := v_now + ((p_lease_ms::text || ' milliseconds')::interval);

  with candidates as (
    select id
    from telegram_updates
    where (
      state in ('pending_engine', 'retry_wait')
      and next_attempt_at <= v_now
    ) or (
      state = 'leased'
      and lease_expires_at <= v_now
    )
    order by
      case when state = 'leased' then lease_expires_at else next_attempt_at end,
      received_at,
      id
    for update skip locked
    limit p_limit
  ),
  updated as (
    update telegram_updates u
    set state = 'leased',
        attempts = u.attempts + 1,
        lease_owner = p_worker_id,
        lease_expires_at = v_lease_expires,
        leased_at = v_now,
        updated_at = v_now,
        last_error_code = case
          when u.state = 'leased' then 'lease_expired'
          else u.last_error_code
        end
    from candidates
    where u.id = candidates.id
    returning u.*
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', id,
        'telegram_update_id', telegram_update_id,
        'update_type', update_type,
        'routing_decision', routing_decision,
        'state', state,
        'attempts', attempts,
        'source_fingerprint', source_fingerprint,
        'payload', payload,
        'lease_expires_at', lease_expires_at
      )
      order by leased_at, id
    ),
    '[]'::jsonb
  )
  into v_items
  from updated;

  return jsonb_build_object('ok', true, 'items', v_items);
end;
$$;

create function telegram_complete_update(
  p_update_row_id uuid,
  p_worker_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row telegram_updates%rowtype;
begin
  if p_update_row_id is null or p_worker_id is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;

  select *
  into v_row
  from telegram_updates
  where id = p_update_row_id
  for update;

  if v_row.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_row.state = 'completed' then
    return jsonb_build_object('ok', true, 'id', v_row.id, 'state', v_row.state, 'duplicate', true);
  end if;
  if v_row.state in ('dead', 'routed_concierge') then
    return jsonb_build_object('ok', false, 'code', 'terminal_state', 'state', v_row.state);
  end if;
  if v_row.state <> 'leased'
     or v_row.lease_owner is distinct from p_worker_id
     or v_row.lease_expires_at is null
     or v_row.lease_expires_at <= v_now then
    return jsonb_build_object('ok', false, 'code', 'lease_lost');
  end if;

  update telegram_updates
  set state = 'completed',
      lease_owner = null,
      lease_expires_at = null,
      completed_at = v_now,
      updated_at = v_now,
      last_error_code = null
  where id = p_update_row_id
  returning * into v_row;

  return jsonb_build_object('ok', true, 'id', v_row.id, 'state', v_row.state, 'duplicate', false);
end;
$$;

create function telegram_retry_update(
  p_update_row_id uuid,
  p_worker_id uuid,
  p_error_code text,
  p_retry_at timestamptz,
  p_max_attempts integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row telegram_updates%rowtype;
begin
  if p_update_row_id is null
     or p_worker_id is null
     or not telegram_is_bounded_code(p_error_code)
     or p_retry_at is null
     or p_retry_at <= v_now
     or p_max_attempts is null
     or p_max_attempts < 1
     or p_max_attempts > 100 then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;

  select *
  into v_row
  from telegram_updates
  where id = p_update_row_id
  for update;

  if v_row.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_row.state = 'dead' then
    return jsonb_build_object('ok', true, 'id', v_row.id, 'state', v_row.state, 'duplicate', true);
  end if;
  if v_row.state in ('completed', 'routed_concierge') then
    return jsonb_build_object('ok', false, 'code', 'terminal_state', 'state', v_row.state);
  end if;
  if v_row.state <> 'leased'
     or v_row.lease_owner is distinct from p_worker_id
     or v_row.lease_expires_at is null
     or v_row.lease_expires_at <= v_now then
    return jsonb_build_object('ok', false, 'code', 'lease_lost');
  end if;

  if v_row.attempts >= p_max_attempts then
    update telegram_updates
    set state = 'dead',
        lease_owner = null,
        lease_expires_at = null,
        last_error_code = p_error_code,
        dead_at = v_now,
        updated_at = v_now
    where id = p_update_row_id
    returning * into v_row;

    return jsonb_build_object('ok', true, 'id', v_row.id, 'state', v_row.state, 'duplicate', false);
  end if;

  update telegram_updates
  set state = 'retry_wait',
      lease_owner = null,
      lease_expires_at = null,
      last_error_code = p_error_code,
      next_attempt_at = p_retry_at,
      updated_at = v_now
  where id = p_update_row_id
  returning * into v_row;

  return jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'state', v_row.state,
    'next_attempt_at', v_row.next_attempt_at,
    'duplicate', false
  );
end;
$$;

create function telegram_dead_letter_update(
  p_update_row_id uuid,
  p_worker_id uuid,
  p_error_code text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row telegram_updates%rowtype;
begin
  if p_update_row_id is null or p_worker_id is null or not telegram_is_bounded_code(p_error_code) then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;

  select *
  into v_row
  from telegram_updates
  where id = p_update_row_id
  for update;

  if v_row.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_row.state = 'dead' then
    return jsonb_build_object('ok', true, 'id', v_row.id, 'state', v_row.state, 'duplicate', true);
  end if;
  if v_row.state in ('completed', 'routed_concierge') then
    return jsonb_build_object('ok', false, 'code', 'terminal_state', 'state', v_row.state);
  end if;
  if v_row.state <> 'leased'
     or v_row.lease_owner is distinct from p_worker_id
     or v_row.lease_expires_at is null
     or v_row.lease_expires_at <= v_now then
    return jsonb_build_object('ok', false, 'code', 'lease_lost');
  end if;

  update telegram_updates
  set state = 'dead',
      lease_owner = null,
      lease_expires_at = null,
      last_error_code = p_error_code,
      dead_at = v_now,
      updated_at = v_now
  where id = p_update_row_id
  returning * into v_row;

  return jsonb_build_object('ok', true, 'id', v_row.id, 'state', v_row.state, 'duplicate', false);
end;
$$;

create function telegram_plan_outbound(
  p_logical_key text,
  p_chat_id bigint,
  p_domain_kind text,
  p_domain_id text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row telegram_outbound_ownership_jobs%rowtype;
begin
  if p_logical_key is null
     or char_length(p_logical_key) not between 1 and 256
     or p_chat_id is null
     or not telegram_is_bounded_code(p_domain_kind)
     or p_domain_id is null
     or char_length(p_domain_id) not between 1 and 256 then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;

  begin
    insert into telegram_outbound_ownership_jobs (
      logical_key,
      chat_id,
      domain_kind,
      domain_id,
      state
    )
    values (
      p_logical_key,
      p_chat_id,
      p_domain_kind,
      p_domain_id,
      'planned'
    )
    returning * into v_row;
  exception
    when unique_violation then
      select *
      into v_row
      from telegram_outbound_ownership_jobs
      where logical_key = p_logical_key
      for update;

      if v_row.id is null then
        raise;
      end if;

      if v_row.chat_id = p_chat_id
         and v_row.domain_kind = p_domain_kind
         and v_row.domain_id = p_domain_id then
        return jsonb_build_object(
          'ok', true,
          'id', v_row.id,
          'state', v_row.state,
          'chat_id', v_row.chat_id,
          'domain_kind', v_row.domain_kind,
          'domain_id', v_row.domain_id,
          'duplicate', true
        );
      end if;

      return jsonb_build_object('ok', false, 'code', 'logical_key_conflict');
  end;

  return jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'state', v_row.state,
    'chat_id', v_row.chat_id,
    'domain_kind', v_row.domain_kind,
    'domain_id', v_row.domain_id,
    'duplicate', false
  );
end;
$$;

create function telegram_start_outbound(
  p_job_id uuid,
  p_worker_id uuid,
  p_lease_ms integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row telegram_outbound_ownership_jobs%rowtype;
begin
  if p_job_id is null or p_worker_id is null or p_lease_ms is null or p_lease_ms < 1 or p_lease_ms > 86400000 then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;

  select *
  into v_row
  from telegram_outbound_ownership_jobs
  where id = p_job_id
  for update;

  if v_row.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_row.state <> 'planned' then
    return jsonb_build_object('ok', false, 'code', 'terminal_state', 'state', v_row.state);
  end if;

  update telegram_outbound_ownership_jobs
  set state = 'sending',
      send_attempts = 1,
      lease_owner = p_worker_id,
      lease_expires_at = v_now + ((p_lease_ms::text || ' milliseconds')::interval),
      sending_at = v_now,
      updated_at = v_now,
      last_error_code = null
  where id = p_job_id
  returning * into v_row;

  return jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'state', v_row.state,
    'chat_id', v_row.chat_id,
    'domain_kind', v_row.domain_kind,
    'domain_id', v_row.domain_id,
    'lease_expires_at', v_row.lease_expires_at
  );
end;
$$;

create function telegram_mark_outbound_owned(
  p_job_id uuid,
  p_worker_id uuid,
  p_message_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row telegram_outbound_ownership_jobs%rowtype;
  v_existing_job_id uuid;
  v_existing_message_id bigint;
begin
  if p_job_id is null or p_worker_id is null or p_message_id is null or p_message_id <= 0 then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;

  select *
  into v_row
  from telegram_outbound_ownership_jobs
  where id = p_job_id
  for update;

  if v_row.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  if v_row.state in ('owned', 'complete') and v_row.telegram_message_id = p_message_id then
    return jsonb_build_object('ok', true, 'id', v_row.id, 'state', v_row.state, 'duplicate', true);
  end if;
  if v_row.state in ('complete', 'reconciled', 'manual_review') then
    return jsonb_build_object('ok', false, 'code', 'terminal_state', 'state', v_row.state);
  end if;
  if v_row.state <> 'sending'
     or v_row.lease_owner is distinct from p_worker_id
     or v_row.lease_expires_at is null
     or v_row.lease_expires_at <= v_now then
    return jsonb_build_object('ok', false, 'code', 'lease_lost');
  end if;

  begin
    insert into engine_owned_messages (
      chat_id,
      message_id,
      outbound_job_id,
      ownership_source,
      owned_at
    )
    values (
      v_row.chat_id,
      p_message_id,
      v_row.id,
      'live',
      v_now
    );
  exception
    when unique_violation then
      select outbound_job_id
      into v_existing_job_id
      from engine_owned_messages
      where chat_id = v_row.chat_id
        and message_id = p_message_id;

      if v_existing_job_id = v_row.id then
        update telegram_outbound_ownership_jobs
        set state = 'owned',
            telegram_message_id = p_message_id,
            owned_at = coalesce(owned_at, v_now),
            lease_owner = null,
            lease_expires_at = null,
            updated_at = v_now,
            last_error_code = null
        where id = p_job_id
        returning * into v_row;

        return jsonb_build_object('ok', true, 'id', v_row.id, 'state', v_row.state, 'duplicate', true);
      end if;

      return jsonb_build_object('ok', false, 'code', 'ownership_conflict');
  end;

  update telegram_outbound_ownership_jobs
  set state = 'owned',
      telegram_message_id = p_message_id,
      owned_at = v_now,
      lease_owner = null,
      lease_expires_at = null,
      updated_at = v_now,
      last_error_code = null
  where id = p_job_id
  returning * into v_row;

  return jsonb_build_object('ok', true, 'id', v_row.id, 'state', v_row.state, 'duplicate', false);
end;
$$;

create function telegram_complete_outbound(
  p_job_id uuid,
  p_worker_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row telegram_outbound_ownership_jobs%rowtype;
begin
  if p_job_id is null or p_worker_id is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;

  select *
  into v_row
  from telegram_outbound_ownership_jobs
  where id = p_job_id
  for update;

  if v_row.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_row.state = 'complete' then
    return jsonb_build_object('ok', true, 'id', v_row.id, 'state', v_row.state, 'duplicate', true);
  end if;
  if v_row.state not in ('owned', 'reconciled') then
    return jsonb_build_object('ok', false, 'code', 'terminal_state', 'state', v_row.state);
  end if;
  if v_row.lease_owner is distinct from p_worker_id
     or v_row.lease_expires_at is null
     or v_row.lease_expires_at <= v_now then
    return jsonb_build_object('ok', false, 'code', 'lease_lost');
  end if;

  update telegram_outbound_ownership_jobs
  set state = 'complete',
      completed_at = v_now,
      lease_owner = null,
      lease_expires_at = null,
      updated_at = v_now
  where id = p_job_id
  returning * into v_row;

  return jsonb_build_object('ok', true, 'id', v_row.id, 'state', v_row.state, 'duplicate', false);
end;
$$;

create function telegram_mark_outbound_uncertain(
  p_job_id uuid,
  p_worker_id uuid,
  p_error_code text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row telegram_outbound_ownership_jobs%rowtype;
begin
  if p_job_id is null or p_worker_id is null or not telegram_is_bounded_code(p_error_code) then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;

  select *
  into v_row
  from telegram_outbound_ownership_jobs
  where id = p_job_id
  for update;

  if v_row.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_row.state = 'ownership_uncertain' then
    return jsonb_build_object('ok', true, 'id', v_row.id, 'state', v_row.state, 'duplicate', true);
  end if;
  if v_row.state in ('complete', 'reconciled', 'manual_review') then
    return jsonb_build_object('ok', false, 'code', 'terminal_state', 'state', v_row.state);
  end if;
  if v_row.state <> 'sending'
     or v_row.lease_owner is distinct from p_worker_id
     or v_row.lease_expires_at is null
     or v_row.lease_expires_at <= v_now then
    return jsonb_build_object('ok', false, 'code', 'lease_lost');
  end if;

  update telegram_outbound_ownership_jobs
  set state = 'ownership_uncertain',
      uncertain_at = coalesce(uncertain_at, v_now),
      next_attempt_at = v_now,
      lease_owner = null,
      lease_expires_at = null,
      last_error_code = p_error_code,
      updated_at = v_now
  where id = p_job_id
  returning * into v_row;

  return jsonb_build_object('ok', true, 'id', v_row.id, 'state', v_row.state, 'duplicate', false);
end;
$$;

create function telegram_sweep_expired_outbound(
  p_limit integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_count integer;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;

  with candidates as (
    select id
    from telegram_outbound_ownership_jobs
    where state = 'sending'
      and lease_expires_at <= v_now
    order by lease_expires_at, id
    for update skip locked
    limit p_limit
  ),
  updated as (
    update telegram_outbound_ownership_jobs j
    set state = 'ownership_uncertain',
        uncertain_at = coalesce(j.uncertain_at, v_now),
        next_attempt_at = v_now,
        lease_owner = null,
        lease_expires_at = null,
        last_error_code = 'lease_expired',
        updated_at = v_now
    from candidates
    where j.id = candidates.id
    returning 1
  )
  select count(*)::int into v_count from updated;

  return jsonb_build_object('ok', true, 'count', coalesce(v_count, 0));
end;
$$;

create function telegram_lease_uncertain_ownership(
  p_worker_id uuid,
  p_limit integer,
  p_lease_ms integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_items jsonb;
begin
  if p_worker_id is null or p_limit is null or p_lease_ms is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;
  if p_limit < 1 or p_limit > 100 or p_lease_ms < 1 or p_lease_ms > 86400000 then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;

  with candidates as (
    select id
    from telegram_outbound_ownership_jobs
    where state = 'ownership_uncertain'
      and next_attempt_at <= v_now
      and (lease_owner is null or lease_expires_at <= v_now)
    order by next_attempt_at, uncertain_at, id
    for update skip locked
    limit p_limit
  ),
  updated as (
    update telegram_outbound_ownership_jobs j
    set reconcile_attempts = j.reconcile_attempts + 1,
        lease_owner = p_worker_id,
        lease_expires_at = v_now + ((p_lease_ms::text || ' milliseconds')::interval),
        updated_at = v_now,
        last_error_code = case
          when j.lease_owner is not null and j.lease_expires_at <= v_now then 'lease_expired'
          else j.last_error_code
        end
    from candidates
    where j.id = candidates.id
    returning j.*
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', id,
        'chat_id', chat_id,
        'domain_kind', domain_kind,
        'domain_id', domain_id,
        'state', state,
        'reconcile_attempts', reconcile_attempts,
        'lease_expires_at', lease_expires_at
      )
      order by next_attempt_at, id
    ),
    '[]'::jsonb
  )
  into v_items
  from updated;

  return jsonb_build_object('ok', true, 'items', v_items);
end;
$$;

create function telegram_lease_outbound_completion(
  p_worker_id uuid,
  p_limit integer,
  p_lease_ms integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_items jsonb;
begin
  if p_worker_id is null or p_limit is null or p_lease_ms is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;
  if p_limit < 1 or p_limit > 100 or p_lease_ms < 1 or p_lease_ms > 86400000 then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;

  with candidates as (
    select id
    from telegram_outbound_ownership_jobs
    where state in ('owned', 'reconciled')
      and (lease_owner is null or lease_expires_at <= v_now)
    order by lease_expires_at, id
    for update skip locked
    limit p_limit
  ),
  updated as (
    update telegram_outbound_ownership_jobs j
    set lease_owner = p_worker_id,
        lease_expires_at = v_now + ((p_lease_ms::text || ' milliseconds')::interval),
        updated_at = v_now
    from candidates
    where j.id = candidates.id
    returning j.*
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', id,
        'chat_id', chat_id,
        'domain_kind', domain_kind,
        'domain_id', domain_id,
        'state', state,
        'telegram_message_id', telegram_message_id,
        'lease_expires_at', lease_expires_at
      )
      order by lease_expires_at, id
    ),
    '[]'::jsonb
  )
  into v_items
  from updated;

  return jsonb_build_object('ok', true, 'items', v_items);
end;
$$;

create function telegram_reconcile_outbound(
  p_job_id uuid,
  p_worker_id uuid,
  p_message_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row telegram_outbound_ownership_jobs%rowtype;
  v_existing_job_id uuid;
begin
  if p_job_id is null or p_worker_id is null or p_message_id is null or p_message_id <= 0 then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;

  select *
  into v_row
  from telegram_outbound_ownership_jobs
  where id = p_job_id
  for update;

  if v_row.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_row.state = 'reconciled' and v_row.telegram_message_id = p_message_id then
    return jsonb_build_object('ok', true, 'id', v_row.id, 'state', v_row.state, 'duplicate', true);
  end if;
  if v_row.state in ('complete', 'reconciled', 'manual_review') then
    return jsonb_build_object('ok', false, 'code', 'terminal_state', 'state', v_row.state);
  end if;
  if v_row.state <> 'ownership_uncertain'
     or v_row.lease_owner is distinct from p_worker_id
     or v_row.lease_expires_at is null
     or v_row.lease_expires_at <= v_now then
    return jsonb_build_object('ok', false, 'code', 'lease_lost');
  end if;

  begin
    insert into engine_owned_messages (
      chat_id,
      message_id,
      outbound_job_id,
      ownership_source,
      owned_at
    )
    values (
      v_row.chat_id,
      p_message_id,
      v_row.id,
      'reconciled',
      v_now
    );
  exception
    when unique_violation then
      select outbound_job_id
      into v_existing_job_id
      from engine_owned_messages
      where chat_id = v_row.chat_id
        and message_id = p_message_id;

      if v_existing_job_id = v_row.id then
        update telegram_outbound_ownership_jobs
        set state = 'reconciled',
            telegram_message_id = p_message_id,
            reconciled_at = coalesce(reconciled_at, v_now),
            lease_owner = null,
            lease_expires_at = null,
            updated_at = v_now,
            last_error_code = null
        where id = p_job_id
        returning * into v_row;

        return jsonb_build_object('ok', true, 'id', v_row.id, 'state', v_row.state, 'duplicate', true);
      end if;

      return jsonb_build_object('ok', false, 'code', 'ownership_conflict');
  end;

  update telegram_outbound_ownership_jobs
  set state = 'reconciled',
      telegram_message_id = p_message_id,
      reconciled_at = v_now,
      lease_owner = null,
      lease_expires_at = null,
      updated_at = v_now,
      last_error_code = null
  where id = p_job_id
  returning * into v_row;

  return jsonb_build_object('ok', true, 'id', v_row.id, 'state', v_row.state, 'duplicate', false);
end;
$$;

create function telegram_manual_review_outbound(
  p_job_id uuid,
  p_worker_id uuid,
  p_error_code text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row telegram_outbound_ownership_jobs%rowtype;
begin
  if p_job_id is null or p_worker_id is null or not telegram_is_bounded_code(p_error_code) then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;

  select *
  into v_row
  from telegram_outbound_ownership_jobs
  where id = p_job_id
  for update;

  if v_row.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_row.state = 'manual_review' then
    return jsonb_build_object('ok', true, 'id', v_row.id, 'state', v_row.state, 'duplicate', true);
  end if;
  if v_row.state in ('complete', 'reconciled') then
    return jsonb_build_object('ok', false, 'code', 'terminal_state', 'state', v_row.state);
  end if;
  if v_row.state <> 'ownership_uncertain'
     or v_row.lease_owner is distinct from p_worker_id
     or v_row.lease_expires_at is null
     or v_row.lease_expires_at <= v_now then
    return jsonb_build_object('ok', false, 'code', 'lease_lost');
  end if;

  update telegram_outbound_ownership_jobs
  set state = 'manual_review',
      lease_owner = null,
      lease_expires_at = null,
      manual_review_at = v_now,
      updated_at = v_now,
      last_error_code = p_error_code
  where id = p_job_id
  returning * into v_row;

  return jsonb_build_object('ok', true, 'id', v_row.id, 'state', v_row.state, 'duplicate', false);
end;
$$;

create function telegram_resolve_owned_message(
  p_chat_id bigint,
  p_message_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
begin
  if p_chat_id is null or p_message_id is null or p_message_id <= 0 then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;

  select
    j.id as job_id,
    j.domain_kind,
    j.domain_id
  into v_row
  from engine_owned_messages m
  join telegram_outbound_ownership_jobs j on j.id = m.outbound_job_id
  where m.chat_id = p_chat_id
    and m.message_id = p_message_id;

  if v_row.job_id is null then
    return jsonb_build_object('ok', true, 'owner', 'unknown');
  end if;

  return jsonb_build_object(
    'ok', true,
    'owner', 'engine',
    'job_id', v_row.job_id,
    'domain_kind', v_row.domain_kind,
    'domain_id', v_row.domain_id
  );
end;
$$;

create function engine_heartbeat_worker(
  p_worker_kind text,
  p_worker_id uuid,
  p_stopping boolean
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  if not telegram_is_bounded_code(p_worker_kind) or p_worker_id is null or p_stopping is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;

  insert into engine_worker_heartbeats (
    worker_kind,
    worker_id,
    started_at,
    heartbeat_at,
    stopping_at
  )
  values (
    p_worker_kind,
    p_worker_id,
    v_now,
    v_now,
    case when p_stopping then v_now else null end
  )
  on conflict (worker_kind, worker_id) do update
    set heartbeat_at = excluded.heartbeat_at,
        stopping_at = case when p_stopping then excluded.heartbeat_at else null end;

  return jsonb_build_object('ok', true);
end;
$$;

create function telegram_delivery_snapshot(
  p_observed_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ingress_active_count integer;
  v_ingress_dead_count integer;
  v_ingress_oldest_age_ms bigint;
  v_outbound_uncertain_count integer;
  v_outbound_manual_count integer;
  v_outbound_oldest_age_ms bigint;
  v_workers jsonb;
begin
  if p_observed_at is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;

  select
    count(*) filter (where state in ('pending_engine', 'retry_wait', 'leased'))::int,
    count(*) filter (where state = 'dead')::int,
    max(
      case
        when state in ('pending_engine', 'retry_wait', 'leased')
        then floor(extract(epoch from (p_observed_at - received_at)) * 1000)::bigint
        else null
      end
    )
  into
    v_ingress_active_count,
    v_ingress_dead_count,
    v_ingress_oldest_age_ms
  from telegram_updates;

  select
    count(*) filter (where state = 'ownership_uncertain')::int,
    count(*) filter (where state = 'manual_review')::int,
    max(
      case
        when state in ('ownership_uncertain', 'manual_review')
        then floor(extract(epoch from (p_observed_at - uncertain_at)) * 1000)::bigint
        else null
      end
    )
  into
    v_outbound_uncertain_count,
    v_outbound_manual_count,
    v_outbound_oldest_age_ms
  from telegram_outbound_ownership_jobs;

  with latest as (
    select distinct on (worker_kind)
      worker_kind,
      worker_id,
      started_at,
      heartbeat_at,
      stopping_at
    from engine_worker_heartbeats
    where worker_kind in ('telegram_ingress', 'telegram_outbound', 'telegram_ownership_reconciler')
    order by worker_kind, heartbeat_at desc, worker_id
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'worker_kind', worker_kind,
        'worker_id', worker_id,
        'started_at', started_at,
        'heartbeat_at', heartbeat_at,
        'stopping_at', stopping_at
      )
      order by worker_kind
    ),
    '[]'::jsonb
  )
  into v_workers
  from latest;

  return jsonb_build_object(
    'ok', true,
    'observed_at', p_observed_at,
    'ingress_active_count', coalesce(v_ingress_active_count, 0),
    'ingress_dead_count', coalesce(v_ingress_dead_count, 0),
    'ingress_oldest_age_ms', v_ingress_oldest_age_ms,
    'outbound_uncertain_count', coalesce(v_outbound_uncertain_count, 0),
    'outbound_manual_review_count', coalesce(v_outbound_manual_count, 0),
    'outbound_oldest_age_ms', v_outbound_oldest_age_ms,
    'workers', v_workers
  );
end;
$$;

create function telegram_prune_delivery(
  p_limit integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_purged_payloads integer;
  v_deleted_ingress integer;
  v_deleted_outbound integer;
  v_deleted_heartbeats integer;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;

  with payload_candidates as (
    select id
    from telegram_updates
    where payload is not null
      and payload_purged_at is null
      and (
        (state = 'completed' and completed_at <= v_now - interval '7 days')
        or (state = 'routed_concierge' and routed_at <= v_now - interval '7 days')
      )
    order by coalesce(completed_at, routed_at), id
    limit p_limit
  ),
  payload_updated as (
    update telegram_updates u
    set payload = null,
        payload_purged_at = v_now,
        updated_at = v_now
    from payload_candidates
    where u.id = payload_candidates.id
    returning 1
  )
  select count(*)::int into v_purged_payloads from payload_updated;

  with ingress_candidates as (
    select id
    from telegram_updates
    where (
      state = 'completed'
      and completed_at <= v_now - interval '30 days'
    ) or (
      state = 'routed_concierge'
      and routed_at <= v_now - interval '30 days'
    ) or (
      state = 'dead'
      and dead_at <= v_now - interval '30 days'
    )
    order by coalesce(completed_at, routed_at, dead_at), id
    limit p_limit
  ),
  ingress_deleted as (
    delete from telegram_updates
    where id in (select id from ingress_candidates)
    returning 1
  )
  select count(*)::int into v_deleted_ingress from ingress_deleted;

  with outbound_candidates as (
    select id
    from telegram_outbound_ownership_jobs
    where (
      state = 'complete'
      and completed_at <= v_now - interval '30 days'
    ) or (
      state = 'manual_review'
      and manual_review_at <= v_now - interval '30 days'
    )
    order by coalesce(completed_at, manual_review_at), id
    limit p_limit
  ),
  outbound_deleted as (
    delete from telegram_outbound_ownership_jobs
    where id in (select id from outbound_candidates)
    returning 1
  )
  select count(*)::int into v_deleted_outbound from outbound_deleted;

  with heartbeat_candidates as (
    select worker_kind, worker_id
    from engine_worker_heartbeats
    where stopping_at is not null
      and stopping_at <= v_now - interval '30 days'
    order by stopping_at, worker_kind, worker_id
    limit p_limit
  ),
  heartbeat_deleted as (
    delete from engine_worker_heartbeats h
    using heartbeat_candidates
    where h.worker_kind = heartbeat_candidates.worker_kind
      and h.worker_id = heartbeat_candidates.worker_id
    returning 1
  )
  select count(*)::int into v_deleted_heartbeats from heartbeat_deleted;

  return jsonb_build_object(
    'ok', true,
    'purged_payloads', coalesce(v_purged_payloads, 0),
    'deleted_ingress_rows', coalesce(v_deleted_ingress, 0),
    'deleted_outbound_jobs', coalesce(v_deleted_outbound, 0),
    'deleted_heartbeats', coalesce(v_deleted_heartbeats, 0)
  );
end;
$$;

revoke execute on function
  telegram_is_bounded_code(text),
  telegram_is_source_fingerprint(text),
  telegram_persist_update(text, text, bigint, text, jsonb, text),
  telegram_lease_updates(uuid, integer, integer),
  telegram_complete_update(uuid, uuid),
  telegram_retry_update(uuid, uuid, text, timestamptz, integer),
  telegram_dead_letter_update(uuid, uuid, text),
  telegram_plan_outbound(text, bigint, text, text),
  telegram_start_outbound(uuid, uuid, integer),
  telegram_mark_outbound_owned(uuid, uuid, bigint),
  telegram_complete_outbound(uuid, uuid),
  telegram_mark_outbound_uncertain(uuid, uuid, text),
  telegram_sweep_expired_outbound(integer),
  telegram_lease_uncertain_ownership(uuid, integer, integer),
  telegram_lease_outbound_completion(uuid, integer, integer),
  telegram_reconcile_outbound(uuid, uuid, bigint),
  telegram_manual_review_outbound(uuid, uuid, text),
  telegram_resolve_owned_message(bigint, bigint),
  engine_heartbeat_worker(text, uuid, boolean),
  telegram_delivery_snapshot(timestamptz),
  telegram_prune_delivery(integer)
from public, anon, authenticated;

grant execute on function
  telegram_persist_update(text, text, bigint, text, jsonb, text),
  telegram_lease_updates(uuid, integer, integer),
  telegram_complete_update(uuid, uuid),
  telegram_retry_update(uuid, uuid, text, timestamptz, integer),
  telegram_dead_letter_update(uuid, uuid, text),
  telegram_plan_outbound(text, bigint, text, text),
  telegram_start_outbound(uuid, uuid, integer),
  telegram_mark_outbound_owned(uuid, uuid, bigint),
  telegram_complete_outbound(uuid, uuid),
  telegram_mark_outbound_uncertain(uuid, uuid, text),
  telegram_sweep_expired_outbound(integer),
  telegram_lease_uncertain_ownership(uuid, integer, integer),
  telegram_lease_outbound_completion(uuid, integer, integer),
  telegram_reconcile_outbound(uuid, uuid, bigint),
  telegram_manual_review_outbound(uuid, uuid, text),
  telegram_resolve_owned_message(bigint, bigint),
  engine_heartbeat_worker(text, uuid, boolean),
  telegram_delivery_snapshot(timestamptz),
  telegram_prune_delivery(integer)
to service_role;
