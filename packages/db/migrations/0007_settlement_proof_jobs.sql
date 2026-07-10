begin;

-- Existing public proof facts must be unambiguous before a unique identity can
-- become authoritative. Do not choose a winner during a migration.
do $$
begin
  if exists (
    select 1
    from proofs
    group by market_id, kind
    having count(*) > 1
  ) then
    raise exception 'proof_identity_conflict';
  end if;
end;
$$;

alter table proofs
  add constraint proofs_market_id_kind_key unique (market_id, kind);

alter table proofs
  add constraint proofs_verified_shape_check check (
    (
      status = 'verified'
      and merkle_proof is not null
      and validate_stat_tx is not null
      and explorer_url is not null
      and verified_at is not null
    )
    or (
      status <> 'verified'
      and verified_at is null
    )
  );

create function settlement_immutable_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'settlement_immutable';
  end if;

  if old.market_id is distinct from new.market_id
     or old.outcome is distinct from new.outcome
     or old.deciding_seq is distinct from new.deciding_seq
     or old.evidence_seqs is distinct from new.evidence_seqs
     or old.tier is distinct from new.tier
     or old.settled_at is distinct from new.settled_at then
    raise exception 'settlement_immutable';
  end if;

  if old.posted_at is not null and old.posted_at is distinct from new.posted_at then
    raise exception 'settlement_posted_at_immutable';
  end if;

  return new;
end;
$$;

create trigger settlements_immutable_guard_trigger
before update or delete on settlements
for each row execute function settlement_immutable_guard();

create function proof_terminal_immutable_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status in ('verified', 'failed', 'unavailable') then
    if tg_op = 'DELETE' or old is distinct from new then
      raise exception 'proof_terminal_immutable';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger proofs_terminal_immutable_guard_trigger
before update or delete on proofs
for each row execute function proof_terminal_immutable_guard();

create table settlement_proof_jobs (
  market_id        uuid not null references markets(id),
  job_kind         text not null check (job_kind in ('settlement', 'proof')),
  status           text not null check (status in ('pending', 'leased', 'retry_wait', 'complete', 'dead')),
  attempts         integer not null default 0 check (attempts between 0 and 100),
  max_attempts     integer not null check (max_attempts between 1 and 100 and attempts <= max_attempts),
  lease_ms         integer not null check (lease_ms between 1000 and 900000),
  retry_base_ms    integer not null check (retry_base_ms > 0),
  retry_max_ms     integer not null check (retry_max_ms >= retry_base_ms),
  due_at           timestamptz not null,
  lease_owner      text check (lease_owner is null or (char_length(lease_owner) <= 128 and btrim(lease_owner) <> '')),
  lease_token      uuid,
  leased_at        timestamptz,
  lease_expires_at timestamptz,
  last_error_code  text check (last_error_code is null or last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at       timestamptz not null,
  updated_at       timestamptz not null,
  completed_at     timestamptz,
  dead_at          timestamptz,
  primary key (market_id, job_kind),
  check (
    (status = 'pending'
      and attempts = 0
      and lease_owner is null
      and lease_token is null
      and leased_at is null
      and lease_expires_at is null
      and last_error_code is null
      and completed_at is null
      and dead_at is null)
    or (status = 'leased'
      and attempts >= 1
      and lease_owner is not null
      and lease_token is not null
      and leased_at is not null
      and lease_expires_at is not null
      and lease_expires_at > leased_at
      and completed_at is null
      and dead_at is null)
    or (status = 'retry_wait'
      and attempts >= 1
      and lease_owner is not null
      and lease_token is not null
      and leased_at is not null
      and lease_expires_at is not null
      and lease_expires_at > leased_at
      and last_error_code is not null
      and completed_at is null
      and dead_at is null)
    or (status = 'complete'
      and attempts >= 1
      and lease_owner is not null
      and lease_token is not null
      and leased_at is not null
      and lease_expires_at is not null
      and lease_expires_at > leased_at
      and last_error_code is null
      and completed_at is not null
      and dead_at is null)
    or (status = 'dead'
      and attempts >= 1
      and lease_owner is not null
      and lease_token is not null
      and leased_at is not null
      and lease_expires_at is not null
      and lease_expires_at > leased_at
      and last_error_code is not null
      and completed_at is null
      and dead_at is not null)
  )
);

create index settlement_proof_jobs_ready_idx
  on settlement_proof_jobs (job_kind, due_at, created_at, market_id)
  where status in ('pending', 'retry_wait');

create index settlement_proof_jobs_expired_lease_idx
  on settlement_proof_jobs (job_kind, lease_expires_at, created_at, market_id)
  where status = 'leased';

create index settlement_proof_jobs_dead_idx
  on settlement_proof_jobs (job_kind, dead_at)
  where status = 'dead';

create function settlement_proof_terminal_job_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status in ('complete', 'dead') then
    if tg_op = 'DELETE' or old is distinct from new then
      raise exception 'settlement_proof_job_terminal_immutable';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger settlement_proof_jobs_terminal_guard_trigger
before update or delete on settlement_proof_jobs
for each row execute function settlement_proof_terminal_job_guard();

alter table settlement_proof_jobs enable row level security;
revoke all privileges on table settlement_proof_jobs from public, anon, authenticated, service_role;

create function settlement_proof_is_bounded_code(p_value text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_value is not null and p_value ~ '^[a-z][a-z0-9_]{0,63}$';
$$;

create function settlement_proof_valid_policy(
  p_max_attempts integer,
  p_lease_ms integer,
  p_retry_base_ms integer,
  p_retry_max_ms integer
) returns boolean
language sql
immutable
set search_path = public
as $$
  select p_max_attempts between 1 and 100
    and p_lease_ms between 1000 and 900000
    and p_retry_base_ms > 0
    and p_retry_max_ms >= p_retry_base_ms;
$$;

create function settlement_proof_settlement_graph_complete(p_market_id uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1
    from settlements s
    where s.market_id = p_market_id
      and s.posted_at is not null
      and exists (
        select 1
        from wager_settlements_applied w
        where w.market_id = p_market_id
      )
      and exists (
        select 1
        from settlement_proof_jobs j
        where j.market_id = p_market_id
          and j.job_kind = 'proof'
      )
  );
$$;

create function settlement_proof_proof_completion_allowed(p_market_id uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1
    from settlements s
    where s.market_id = p_market_id
      and (
        s.outcome = 'void'
        or s.tier = 'oracle_resolved'
        or exists (
          select 1
          from proofs p
          where p.market_id = p_market_id
            and p.kind = 'stat'
            and p.status in ('verified', 'unavailable')
        )
      )
  );
$$;

create function settlement_proof_proof_dead_allowed(p_market_id uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1
    from proofs p
    where p.market_id = p_market_id
      and p.kind = 'stat'
      and p.status in ('failed', 'unavailable')
  );
$$;

create function settlement_record_terminal(
  p_market_id uuid,
  p_outcome text,
  p_deciding_seq bigint,
  p_evidence_seqs bigint[],
  p_tier text,
  p_now timestamptz,
  p_max_attempts integer,
  p_lease_ms integer,
  p_retry_base_ms integer,
  p_retry_max_ms integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_market markets%rowtype;
  v_settlement settlements%rowtype;
  v_required_status text;
  v_duplicate boolean := false;
  v_job_status text;
begin
  if not settlement_proof_valid_policy(p_max_attempts, p_lease_ms, p_retry_base_ms, p_retry_max_ms) then
    return jsonb_build_object('ok', false, 'code', 'invalid_queue_policy');
  end if;

  if p_market_id is null then
    return jsonb_build_object('ok', false, 'code', 'market_not_found');
  end if;

  if p_now is null
     or p_outcome not in ('claim_won', 'claim_lost', 'void')
     or p_evidence_seqs is null
     or p_tier not in ('chain_proven', 'oracle_resolved') then
    return jsonb_build_object('ok', false, 'code', 'settlement_fact_conflict');
  end if;

  select * into v_market
  from markets
  where id = p_market_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'market_not_found');
  end if;
  if v_market.currency <> 'sol' then
    return jsonb_build_object('ok', false, 'code', 'market_not_sol');
  end if;

  v_required_status := case when p_outcome = 'void' then 'voided' else 'settled' end;
  if v_market.status in ('settled', 'voided') and v_market.status <> v_required_status then
    return jsonb_build_object('ok', false, 'code', 'terminal_state_conflict');
  end if;
  if (v_market.spec ->> 'trustTier') is distinct from p_tier then
    return jsonb_build_object('ok', false, 'code', 'tier_mismatch');
  end if;

  select * into v_settlement
  from settlements
  where market_id = p_market_id
  for update;

  if found then
    if v_settlement.outcome is distinct from p_outcome
       or v_settlement.deciding_seq is distinct from p_deciding_seq
       or v_settlement.evidence_seqs is distinct from p_evidence_seqs
       or v_settlement.tier is distinct from p_tier then
      return jsonb_build_object('ok', false, 'code', 'settlement_fact_conflict');
    end if;
    v_duplicate := true;
  else
    insert into settlements (market_id, outcome, deciding_seq, evidence_seqs, tier, settled_at)
    values (p_market_id, p_outcome, p_deciding_seq, p_evidence_seqs, p_tier, p_now);
  end if;

  update markets
  set status = v_required_status
  where id = p_market_id
    and status is distinct from v_required_status;

  insert into settlement_proof_jobs (
    market_id, job_kind, status, attempts, max_attempts, lease_ms,
    retry_base_ms, retry_max_ms, due_at, created_at, updated_at
  ) values (
    p_market_id, 'settlement', 'pending', 0, p_max_attempts, p_lease_ms,
    p_retry_base_ms, p_retry_max_ms, p_now, p_now, p_now
  ) on conflict (market_id, job_kind) do nothing;

  select status into v_job_status
  from settlement_proof_jobs
  where market_id = p_market_id and job_kind = 'settlement';

  return jsonb_build_object(
    'ok', true,
    'duplicate', v_duplicate,
    'market_id', p_market_id,
    'job_status', v_job_status
  );
end;
$$;

create function settlement_mark_posted(
  p_market_id uuid,
  p_now timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settlement settlements%rowtype;
begin
  if p_market_id is null or p_now is null then
    return jsonb_build_object('ok', false, 'code', 'settlement_fact_missing');
  end if;

  select * into v_settlement
  from settlements
  where market_id = p_market_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'settlement_fact_missing');
  end if;

  if v_settlement.posted_at is not null then
    return jsonb_build_object('ok', true, 'duplicate', true, 'posted_at', v_settlement.posted_at);
  end if;

  update settlements
  set posted_at = p_now
  where market_id = p_market_id;

  return jsonb_build_object('ok', true, 'duplicate', false, 'posted_at', p_now);
end;
$$;

create function proof_record_state(
  p_market_id uuid,
  p_kind text,
  p_stat_key integer,
  p_seq bigint,
  p_merkle_proof jsonb,
  p_validate_stat_tx text,
  p_explorer_url text,
  p_status text,
  p_now timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_proof proofs%rowtype;
  v_stat_key integer;
  v_seq bigint;
  v_merkle_proof jsonb;
  v_validate_stat_tx text;
  v_explorer_url text;
  v_verified_at timestamptz;
  v_duplicate boolean := false;
begin
  if p_market_id is null
     or p_kind not in ('stat', 'odds')
     or p_status not in ('pending', 'verified', 'failed', 'unavailable')
     or p_now is null then
    return jsonb_build_object('ok', false, 'code', 'proof_fact_conflict');
  end if;

  perform 1 from markets where id = p_market_id for key share;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'market_not_found');
  end if;

  select * into v_proof
  from proofs
  where market_id = p_market_id and kind = p_kind
  for update;

  if not found then
    if p_status <> 'pending' then
      return jsonb_build_object('ok', false, 'code', 'proof_fact_conflict');
    end if;

    insert into proofs (
      market_id, kind, stat_key, seq, merkle_proof, validate_stat_tx,
      explorer_url, status, verified_at
    ) values (
      p_market_id, p_kind, p_stat_key, p_seq, p_merkle_proof, p_validate_stat_tx,
      p_explorer_url, 'pending', null
    );

    return jsonb_build_object(
      'ok', true,
      'duplicate', false,
      'market_id', p_market_id,
      'kind', p_kind,
      'status', 'pending',
      'verified_at', null
    );
  end if;

  if v_proof.status in ('verified', 'failed', 'unavailable') then
    if p_status <> v_proof.status
       or (p_stat_key is not null and p_stat_key is distinct from v_proof.stat_key)
       or (p_seq is not null and p_seq is distinct from v_proof.seq)
       or (p_merkle_proof is not null and p_merkle_proof is distinct from v_proof.merkle_proof)
       or (p_validate_stat_tx is not null and p_validate_stat_tx is distinct from v_proof.validate_stat_tx)
       or (p_explorer_url is not null and p_explorer_url is distinct from v_proof.explorer_url) then
      return jsonb_build_object('ok', false, 'code', 'proof_fact_conflict');
    end if;

    return jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'market_id', p_market_id,
      'kind', p_kind,
      'status', v_proof.status,
      'verified_at', v_proof.verified_at
    );
  end if;

  if p_stat_key is not null and v_proof.stat_key is not null and p_stat_key is distinct from v_proof.stat_key
     or p_seq is not null and v_proof.seq is not null and p_seq is distinct from v_proof.seq
     or p_merkle_proof is not null and v_proof.merkle_proof is not null and p_merkle_proof is distinct from v_proof.merkle_proof
     or p_validate_stat_tx is not null and v_proof.validate_stat_tx is not null and p_validate_stat_tx is distinct from v_proof.validate_stat_tx
     or p_explorer_url is not null and v_proof.explorer_url is not null and p_explorer_url is distinct from v_proof.explorer_url then
    return jsonb_build_object('ok', false, 'code', 'proof_fact_conflict');
  end if;

  v_stat_key := coalesce(v_proof.stat_key, p_stat_key);
  v_seq := coalesce(v_proof.seq, p_seq);
  v_merkle_proof := coalesce(v_proof.merkle_proof, p_merkle_proof);
  v_validate_stat_tx := coalesce(v_proof.validate_stat_tx, p_validate_stat_tx);
  v_explorer_url := coalesce(v_proof.explorer_url, p_explorer_url);

  if p_status = 'verified'
     and (v_merkle_proof is null or v_validate_stat_tx is null or v_explorer_url is null) then
    return jsonb_build_object('ok', false, 'code', 'verified_shape_invalid');
  end if;

  if p_status = 'pending'
     and v_stat_key is not distinct from v_proof.stat_key
     and v_seq is not distinct from v_proof.seq
     and v_merkle_proof is not distinct from v_proof.merkle_proof
     and v_validate_stat_tx is not distinct from v_proof.validate_stat_tx
     and v_explorer_url is not distinct from v_proof.explorer_url then
    v_duplicate := true;
  else
    v_verified_at := case when p_status = 'verified' then p_now else null end;
    update proofs
    set stat_key = v_stat_key,
        seq = v_seq,
        merkle_proof = v_merkle_proof,
        validate_stat_tx = v_validate_stat_tx,
        explorer_url = v_explorer_url,
        status = p_status,
        verified_at = v_verified_at
    where id = v_proof.id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'duplicate', v_duplicate,
    'market_id', p_market_id,
    'kind', p_kind,
    'status', p_status,
    'verified_at', case when p_status = 'verified' then p_now else null end
  );
end;
$$;

create function settlement_proof_enqueue(
  p_market_id uuid,
  p_job_kind text,
  p_due_at timestamptz,
  p_now timestamptz,
  p_max_attempts integer,
  p_lease_ms integer,
  p_retry_base_ms integer,
  p_retry_max_ms integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_market markets%rowtype;
  v_job settlement_proof_jobs%rowtype;
  v_created boolean := false;
begin
  if p_job_kind not in ('settlement', 'proof') then
    return jsonb_build_object('ok', false, 'code', 'invalid_job_kind');
  end if;
  if p_due_at is null or p_now is null
     or not settlement_proof_valid_policy(p_max_attempts, p_lease_ms, p_retry_base_ms, p_retry_max_ms) then
    return jsonb_build_object('ok', false, 'code', 'invalid_queue_policy');
  end if;

  select * into v_market
  from markets
  where id = p_market_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'market_not_found');
  end if;
  if v_market.currency <> 'sol' then
    return jsonb_build_object('ok', false, 'code', 'market_not_sol');
  end if;
  if v_market.status not in ('settled', 'voided') then
    return jsonb_build_object('ok', false, 'code', 'market_not_terminal');
  end if;
  if p_job_kind = 'proof' and not exists (select 1 from settlements where market_id = p_market_id) then
    return jsonb_build_object('ok', false, 'code', 'settlement_fact_missing');
  end if;

  insert into settlement_proof_jobs (
    market_id, job_kind, status, attempts, max_attempts, lease_ms,
    retry_base_ms, retry_max_ms, due_at, created_at, updated_at
  ) values (
    p_market_id, p_job_kind, 'pending', 0, p_max_attempts, p_lease_ms,
    p_retry_base_ms, p_retry_max_ms, p_due_at, p_now, p_now
  ) on conflict (market_id, job_kind) do nothing
  returning * into v_job;

  if found then
    v_created := true;
  else
    select * into v_job
    from settlement_proof_jobs
    where market_id = p_market_id and job_kind = p_job_kind;
  end if;

  return jsonb_build_object('ok', true, 'created', v_created, 'job', to_jsonb(v_job));
end;
$$;

create function settlement_proof_lease(
  p_job_kind text,
  p_worker_id text,
  p_now timestamptz,
  p_limit integer
) returns setof settlement_proof_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job settlement_proof_jobs%rowtype;
  v_outcome text;
  v_tier text;
  v_proof_status text;
begin
  if p_job_kind not in ('settlement', 'proof')
     or p_worker_id is null
     or char_length(p_worker_id) > 128
     or btrim(p_worker_id) = ''
     or p_now is null
     or p_limit is null
     or p_limit < 1
     or p_limit > 100 then
    return;
  end if;

  -- A final expired attempt cannot be acquired again. Resolve it before
  -- healthy work so one poison row cannot consume all lease slots forever.
  for v_job in
    select *
    from settlement_proof_jobs
    where job_kind = p_job_kind
      and status = 'leased'
      and lease_expires_at <= p_now
      and attempts >= max_attempts
    order by lease_expires_at, created_at, market_id
    for update skip locked
  loop
    if v_job.job_kind = 'settlement' then
      if settlement_proof_settlement_graph_complete(v_job.market_id) then
        update settlement_proof_jobs
        set status = 'complete', last_error_code = null, completed_at = p_now, updated_at = p_now
        where market_id = v_job.market_id and job_kind = v_job.job_kind;
      else
        update settlement_proof_jobs
        set status = 'dead', last_error_code = 'lease_expired', dead_at = p_now, updated_at = p_now
        where market_id = v_job.market_id and job_kind = v_job.job_kind;
      end if;
    else
      select outcome, tier into v_outcome, v_tier
      from settlements
      where market_id = v_job.market_id;

      if found and (v_outcome = 'void' or v_tier = 'oracle_resolved') then
        update settlement_proof_jobs
        set status = 'complete', last_error_code = null, completed_at = p_now, updated_at = p_now
        where market_id = v_job.market_id and job_kind = v_job.job_kind;
      else
        select status into v_proof_status
        from proofs
        where market_id = v_job.market_id and kind = 'stat'
        for update;

        if v_proof_status in ('verified', 'unavailable') then
          update settlement_proof_jobs
          set status = 'complete', last_error_code = null, completed_at = p_now, updated_at = p_now
          where market_id = v_job.market_id and job_kind = v_job.job_kind;
        else
          if v_proof_status is null then
            insert into proofs (market_id, kind, status, verified_at)
            values (v_job.market_id, 'stat', 'pending', null)
            on conflict (market_id, kind) do nothing;
          end if;
          update proofs
          set status = 'failed', verified_at = null
          where market_id = v_job.market_id and kind = 'stat' and status = 'pending';
          update settlement_proof_jobs
          set status = 'dead', last_error_code = 'lease_expired', dead_at = p_now, updated_at = p_now
          where market_id = v_job.market_id and job_kind = v_job.job_kind;
        end if;
      end if;
    end if;
  end loop;

  for v_job in
    select *
    from settlement_proof_jobs
    where job_kind = p_job_kind
      and (
        (status in ('pending', 'retry_wait') and due_at <= p_now)
        or (status = 'leased' and lease_expires_at <= p_now and attempts < max_attempts)
      )
    order by
      case when status = 'leased' then lease_expires_at else due_at end,
      created_at,
      market_id
    limit p_limit
    for update skip locked
  loop
    update settlement_proof_jobs
    set status = 'leased',
        attempts = attempts + 1,
        lease_owner = p_worker_id,
        lease_token = gen_random_uuid(),
        leased_at = p_now,
        lease_expires_at = p_now + (lease_ms::text || ' milliseconds')::interval,
        last_error_code = case when v_job.status = 'leased' then 'lease_expired' else v_job.last_error_code end,
        updated_at = p_now
    where market_id = v_job.market_id and job_kind = v_job.job_kind
    returning * into v_job;

    return next v_job;
  end loop;
end;
$$;

create function settlement_proof_complete(
  p_market_id uuid,
  p_job_kind text,
  p_worker_id text,
  p_lease_token uuid,
  p_now timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job settlement_proof_jobs%rowtype;
begin
  select * into v_job
  from settlement_proof_jobs
  where market_id = p_market_id and job_kind = p_job_kind
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'lease_lost');
  end if;

  if v_job.status = 'complete'
     and v_job.lease_owner is not distinct from p_worker_id
     and v_job.lease_token is not distinct from p_lease_token then
    return jsonb_build_object('ok', true, 'status', 'complete', 'duplicate', true);
  end if;

  if p_now is null
     or v_job.status <> 'leased'
     or v_job.lease_owner is distinct from p_worker_id
     or v_job.lease_token is distinct from p_lease_token
     or v_job.lease_expires_at <= p_now then
    return jsonb_build_object('ok', false, 'code', 'lease_lost');
  end if;

  if v_job.job_kind = 'settlement' and not settlement_proof_settlement_graph_complete(p_market_id) then
    return jsonb_build_object('ok', false, 'code', 'effects_incomplete');
  end if;
  if v_job.job_kind = 'proof' and not settlement_proof_proof_completion_allowed(p_market_id) then
    return jsonb_build_object('ok', false, 'code', 'proof_terminal_missing');
  end if;

  update settlement_proof_jobs
  set status = 'complete', last_error_code = null, completed_at = p_now, updated_at = p_now
  where market_id = p_market_id and job_kind = p_job_kind;

  return jsonb_build_object('ok', true, 'status', 'complete', 'duplicate', false);
end;
$$;

create function settlement_proof_retry(
  p_market_id uuid,
  p_job_kind text,
  p_worker_id text,
  p_lease_token uuid,
  p_error_code text,
  p_delay_ms integer,
  p_now timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job settlement_proof_jobs%rowtype;
  v_cap numeric;
begin
  select * into v_job
  from settlement_proof_jobs
  where market_id = p_market_id and job_kind = p_job_kind
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'lease_lost');
  end if;

  if v_job.status in ('retry_wait', 'dead')
     and v_job.lease_owner is not distinct from p_worker_id
     and v_job.lease_token is not distinct from p_lease_token then
    return jsonb_build_object('ok', true, 'status', v_job.status, 'duplicate', true);
  end if;

  if p_now is null
     or not settlement_proof_is_bounded_code(p_error_code)
     or p_delay_ms is null
     or v_job.status <> 'leased'
     or v_job.lease_owner is distinct from p_worker_id
     or v_job.lease_token is distinct from p_lease_token
     or v_job.lease_expires_at <= p_now then
    return jsonb_build_object('ok', false, 'code', 'lease_lost');
  end if;

  v_cap := least(
    v_job.retry_max_ms::numeric,
    v_job.retry_base_ms::numeric * power(2::numeric, v_job.attempts - 1)
  );
  if p_delay_ms <= 0 or p_delay_ms::numeric > v_cap then
    return jsonb_build_object('ok', false, 'code', 'invalid_queue_policy');
  end if;

  if v_job.attempts < v_job.max_attempts then
    update settlement_proof_jobs
    set status = 'retry_wait',
        due_at = p_now + (p_delay_ms::text || ' milliseconds')::interval,
        last_error_code = p_error_code,
        updated_at = p_now
    where market_id = p_market_id and job_kind = p_job_kind;
    return jsonb_build_object('ok', true, 'status', 'retry_wait', 'duplicate', false);
  end if;

  if v_job.job_kind = 'proof' and not settlement_proof_proof_dead_allowed(p_market_id) then
    return jsonb_build_object('ok', false, 'code', 'proof_terminal_missing');
  end if;

  update settlement_proof_jobs
  set status = 'dead', last_error_code = p_error_code, dead_at = p_now, updated_at = p_now
  where market_id = p_market_id and job_kind = p_job_kind;
  return jsonb_build_object('ok', true, 'status', 'dead', 'duplicate', false);
end;
$$;

create function settlement_proof_dead_letter(
  p_market_id uuid,
  p_job_kind text,
  p_worker_id text,
  p_lease_token uuid,
  p_error_code text,
  p_now timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job settlement_proof_jobs%rowtype;
begin
  select * into v_job
  from settlement_proof_jobs
  where market_id = p_market_id and job_kind = p_job_kind
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'lease_lost');
  end if;

  if v_job.status = 'dead'
     and v_job.lease_owner is not distinct from p_worker_id
     and v_job.lease_token is not distinct from p_lease_token then
    return jsonb_build_object('ok', true, 'status', 'dead', 'duplicate', true);
  end if;

  if p_now is null
     or not settlement_proof_is_bounded_code(p_error_code)
     or v_job.status <> 'leased'
     or v_job.lease_owner is distinct from p_worker_id
     or v_job.lease_token is distinct from p_lease_token
     or v_job.lease_expires_at <= p_now then
    return jsonb_build_object('ok', false, 'code', 'lease_lost');
  end if;

  if v_job.job_kind = 'proof' and not settlement_proof_proof_dead_allowed(p_market_id) then
    return jsonb_build_object('ok', false, 'code', 'proof_terminal_missing');
  end if;

  update settlement_proof_jobs
  set status = 'dead', last_error_code = p_error_code, dead_at = p_now, updated_at = p_now
  where market_id = p_market_id and job_kind = p_job_kind;
  return jsonb_build_object('ok', true, 'status', 'dead', 'duplicate', false);
end;
$$;

create function settlement_terminal_gaps(
  p_limit integer
) returns table (
  market_id uuid,
  settlement_job_missing boolean,
  settlement_row_missing boolean,
  wager_marker_missing boolean,
  proof_job_missing boolean,
  proof_terminal_missing boolean,
  chat_post_missing boolean,
  settlement_terminal_conflict boolean,
  proof_terminal_conflict boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    return;
  end if;

  return query
  with gap_rows as (
    select
      m.id,
      not exists (
        select 1 from settlement_proof_jobs j
        where j.market_id = m.id and j.job_kind = 'settlement'
      ) as v_settlement_job_missing,
      s.market_id is null as v_settlement_row_missing,
      not exists (
        select 1 from wager_settlements_applied w
        where w.market_id = m.id
      ) as v_wager_marker_missing,
      not exists (
        select 1 from settlement_proof_jobs j
        where j.market_id = m.id and j.job_kind = 'proof'
      ) as v_proof_job_missing,
      (
        s.market_id is not null
        and s.tier = 'chain_proven'
        and s.outcome <> 'void'
        and not exists (
          select 1 from proofs p
          where p.market_id = m.id
            and p.kind = 'stat'
            and p.status in ('verified', 'unavailable')
        )
      ) as v_proof_terminal_missing,
      s.market_id is not null and s.posted_at is null as v_chat_post_missing,
      (
        s.market_id is not null
        and (
          (m.status = 'voided') is distinct from (s.outcome = 'void')
          or s.tier is distinct from (m.spec ->> 'trustTier')
        )
      )
      or exists (
        select 1 from settlement_proof_jobs j
        where j.market_id = m.id
          and j.job_kind = 'settlement'
          and j.status = 'complete'
          and not settlement_proof_settlement_graph_complete(m.id)
      ) as v_settlement_terminal_conflict,
      exists (
        select 1 from settlement_proof_jobs j
        where j.market_id = m.id
          and j.job_kind = 'proof'
          and (
            (j.status = 'complete' and not settlement_proof_proof_completion_allowed(m.id))
            or (j.status = 'dead' and not settlement_proof_proof_dead_allowed(m.id))
          )
      ) as v_proof_terminal_conflict
    from markets m
    left join settlements s on s.market_id = m.id
    where m.currency = 'sol'
      and m.status in ('settled', 'voided')
  )
  select
    id,
    v_settlement_job_missing,
    v_settlement_row_missing,
    v_wager_marker_missing,
    v_proof_job_missing,
    v_proof_terminal_missing,
    v_chat_post_missing,
    v_settlement_terminal_conflict,
    v_proof_terminal_conflict
  from gap_rows
  where v_settlement_job_missing
     or v_settlement_row_missing
     or v_wager_marker_missing
     or v_proof_job_missing
     or v_proof_terminal_missing
     or v_chat_post_missing
     or v_settlement_terminal_conflict
     or v_proof_terminal_conflict
  order by id
  limit p_limit;
end;
$$;

create function settlement_reconcile_terminal_jobs(
  p_now timestamptz,
  p_limit integer,
  p_max_attempts integer,
  p_lease_ms integer,
  p_retry_base_ms integer,
  p_retry_max_ms integer,
  p_initial_chain_proof_delay_ms integer
) returns table (
  market_id uuid,
  reason_codes text[],
  settlement_job_created boolean,
  proof_job_created boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_market markets%rowtype;
  v_settlement settlements%rowtype;
  v_settlement_job settlement_proof_jobs%rowtype;
  v_proof_job settlement_proof_jobs%rowtype;
  v_due_at timestamptz;
begin
  if p_now is null
     or p_limit is null
     or p_limit < 1
     or p_limit > 1000
     or p_initial_chain_proof_delay_ms is null
     or p_initial_chain_proof_delay_ms < 0
     or not settlement_proof_valid_policy(p_max_attempts, p_lease_ms, p_retry_base_ms, p_retry_max_ms) then
    return;
  end if;

  for v_market in
    select *
    from markets
    where currency = 'sol'
      and status in ('settled', 'voided')
    order by id
    limit p_limit
    for update skip locked
  loop
    market_id := v_market.id;
    reason_codes := '{}'::text[];
    settlement_job_created := false;
    proof_job_created := false;

    select * into v_settlement
    from settlements s
    where s.market_id = v_market.id;

    select * into v_settlement_job
    from settlement_proof_jobs j
    where j.market_id = v_market.id and j.job_kind = 'settlement';
    if not found then
      reason_codes := array_append(reason_codes, 'settlement_job_missing');
      insert into settlement_proof_jobs (
        market_id, job_kind, status, attempts, max_attempts, lease_ms,
        retry_base_ms, retry_max_ms, due_at, created_at, updated_at
      ) values (
        v_market.id, 'settlement', 'pending', 0, p_max_attempts, p_lease_ms,
        p_retry_base_ms, p_retry_max_ms, p_now, p_now, p_now
      );
      settlement_job_created := true;
    elsif v_settlement_job.status = 'complete'
      and not settlement_proof_settlement_graph_complete(v_market.id) then
      reason_codes := array_append(reason_codes, 'settlement_terminal_conflict');
    end if;

    if v_settlement.market_id is null then
      reason_codes := array_append(reason_codes, 'settlement_fact_missing');
    else
      select * into v_proof_job
      from settlement_proof_jobs j
      where j.market_id = v_market.id and j.job_kind = 'proof';
      if not found then
        reason_codes := array_append(reason_codes, 'proof_job_missing');
        v_due_at := case
          when v_settlement.outcome = 'void' or v_settlement.tier = 'oracle_resolved' then p_now
          else p_now + (p_initial_chain_proof_delay_ms::text || ' milliseconds')::interval
        end;
        insert into settlement_proof_jobs (
          market_id, job_kind, status, attempts, max_attempts, lease_ms,
          retry_base_ms, retry_max_ms, due_at, created_at, updated_at
        ) values (
          v_market.id, 'proof', 'pending', 0, p_max_attempts, p_lease_ms,
          p_retry_base_ms, p_retry_max_ms, v_due_at, p_now, p_now
        );
        proof_job_created := true;
      elsif (v_proof_job.status = 'complete' and not settlement_proof_proof_completion_allowed(v_market.id))
         or (v_proof_job.status = 'dead' and not settlement_proof_proof_dead_allowed(v_market.id)) then
        reason_codes := array_append(reason_codes, 'proof_terminal_conflict');
      end if;
    end if;

    return next;
  end loop;
end;
$$;

create function settlement_proof_backlog(
  p_job_kind text,
  p_now timestamptz
) returns table (
  ready_count integer,
  oldest_ready_age_ms bigint,
  active_lease_count integer,
  retry_wait_count integer,
  expired_lease_count integer,
  dead_count integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_job_kind not in ('settlement', 'proof') or p_now is null then
    raise exception 'invalid settlement proof backlog input';
  end if;

  return query
  with rows as (
    select *,
      (
        (status in ('pending', 'retry_wait') and due_at <= p_now)
        or (status = 'leased' and lease_expires_at <= p_now and attempts < max_attempts)
      ) as ready
    from settlement_proof_jobs
    where job_kind = p_job_kind
  )
  select
    count(*) filter (where ready)::int,
    case
      when count(*) filter (where ready) = 0 then null
      else greatest(
        0::bigint,
        floor(extract(epoch from (p_now - min(created_at) filter (where ready))) * 1000)::bigint
      )
    end,
    count(*) filter (where status = 'leased' and lease_expires_at > p_now)::int,
    count(*) filter (where status = 'retry_wait')::int,
    count(*) filter (where status = 'leased' and lease_expires_at <= p_now)::int,
    count(*) filter (where status = 'dead')::int
  from rows;
end;
$$;

revoke execute on function
  settlement_immutable_guard(),
  proof_terminal_immutable_guard(),
  settlement_proof_terminal_job_guard(),
  settlement_proof_is_bounded_code(text),
  settlement_proof_valid_policy(integer, integer, integer, integer),
  settlement_proof_settlement_graph_complete(uuid),
  settlement_proof_proof_completion_allowed(uuid),
  settlement_proof_proof_dead_allowed(uuid),
  settlement_record_terminal(uuid, text, bigint, bigint[], text, timestamptz, integer, integer, integer, integer),
  settlement_mark_posted(uuid, timestamptz),
  proof_record_state(uuid, text, integer, bigint, jsonb, text, text, text, timestamptz),
  settlement_proof_enqueue(uuid, text, timestamptz, timestamptz, integer, integer, integer, integer),
  settlement_proof_lease(text, text, timestamptz, integer),
  settlement_proof_complete(uuid, text, text, uuid, timestamptz),
  settlement_proof_retry(uuid, text, text, uuid, text, integer, timestamptz),
  settlement_proof_dead_letter(uuid, text, text, uuid, text, timestamptz),
  settlement_terminal_gaps(integer),
  settlement_reconcile_terminal_jobs(timestamptz, integer, integer, integer, integer, integer, integer),
  settlement_proof_backlog(text, timestamptz)
from public, anon, authenticated, service_role;

grant execute on function
  settlement_record_terminal(uuid, text, bigint, bigint[], text, timestamptz, integer, integer, integer, integer),
  settlement_mark_posted(uuid, timestamptz),
  proof_record_state(uuid, text, integer, bigint, jsonb, text, text, text, timestamptz),
  settlement_proof_enqueue(uuid, text, timestamptz, timestamptz, integer, integer, integer, integer),
  settlement_proof_lease(text, text, timestamptz, integer),
  settlement_proof_complete(uuid, text, text, uuid, timestamptz),
  settlement_proof_retry(uuid, text, text, uuid, text, integer, timestamptz),
  settlement_proof_dead_letter(uuid, text, text, uuid, text, timestamptz),
  settlement_terminal_gaps(integer),
  settlement_reconcile_terminal_jobs(timestamptz, integer, integer, integer, integer, integer, integer),
  settlement_proof_backlog(text, timestamptz)
to service_role;

commit;
