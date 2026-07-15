-- Finalized MarketClosed projection and durable pre-relayer attestation intent.
--
-- This migration is forward-only. It does not change the public receipt
-- contract and does not read or mutate legacy balances, ledgers, deposits, or
-- withdrawals.

-- Newly-created markets inherit custody from one complete rollout binding.
-- Existing rows are intentionally untouched and remain protected by the 0024
-- update-immutability trigger.
create function public.escrow_assign_market_custody_from_rollout()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_rollout public.escrow_group_rollouts%rowtype;
begin
  select * into v_rollout
  from public.escrow_group_rollouts
  where group_id = new.group_id;

  if v_rollout.group_id is not null
     and v_rollout.custody_mode = 'escrow'
     and v_rollout.cluster in ('localnet', 'devnet', 'mainnet-beta')
     and v_rollout.genesis_hash is not null and v_rollout.genesis_hash <> ''
     and v_rollout.program_id is not null and v_rollout.program_id <> ''
     and v_rollout.custody_version is not null and v_rollout.custody_version > 0 then
    new.custody_mode := 'escrow';
  else
    new.custody_mode := 'legacy';
  end if;
  return new;
end;
$$;

create trigger markets_assign_custody_from_escrow_rollout
before insert on public.markets
for each row execute function public.escrow_assign_market_custody_from_rollout();

create function public.escrow_configure_group_rollout(
  p_group_id bigint,
  p_custody_mode text,
  p_cluster text,
  p_genesis_hash text,
  p_program_id text,
  p_custody_version integer,
  p_enabled_by bigint,
  p_now timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.escrow_group_rollouts%rowtype;
  v_result public.escrow_group_rollouts%rowtype;
  v_created boolean;
begin
  if p_group_id <= 0 or p_now is null
     or p_custody_mode not in ('legacy', 'escrow') then
    raise exception 'escrow_group_rollout_input_invalid';
  end if;
  if p_custody_mode = 'legacy' and (
    p_cluster is not null
    or p_genesis_hash is not null
    or p_program_id is not null
    or p_custody_version is not null
  ) then
    raise exception 'escrow_group_rollout_legacy_binding_forbidden';
  end if;
  if p_custody_mode = 'escrow' and (
    p_cluster not in ('localnet', 'devnet', 'mainnet-beta')
    or p_genesis_hash is null or p_genesis_hash = ''
    or p_program_id is null or p_program_id = ''
    or p_custody_version is null or p_custody_version <= 0
  ) then
    raise exception 'escrow_group_rollout_binding_incomplete';
  end if;
  if not exists (select 1 from public.groups where id = p_group_id) then
    raise exception 'escrow_group_rollout_group_missing';
  end if;
  if p_enabled_by is not null
     and not exists (select 1 from public.users where id = p_enabled_by) then
    raise exception 'escrow_group_rollout_actor_missing';
  end if;

  select * into v_existing
  from public.escrow_group_rollouts
  where group_id = p_group_id
  for update;
  v_created := v_existing.group_id is null;
  if not v_created
     and v_existing.custody_mode is not distinct from p_custody_mode
     and v_existing.cluster is not distinct from p_cluster
     and v_existing.genesis_hash is not distinct from p_genesis_hash
     and v_existing.program_id is not distinct from p_program_id
     and v_existing.custody_version is not distinct from p_custody_version
     and v_existing.enabled_by is not distinct from p_enabled_by then
    v_result := v_existing;
  else
    insert into public.escrow_group_rollouts (
      group_id, custody_mode, cluster, genesis_hash, program_id,
      custody_version, enabled_by, updated_at
    ) values (
      p_group_id, p_custody_mode, p_cluster, p_genesis_hash, p_program_id,
      p_custody_version, p_enabled_by, p_now
    ) on conflict (group_id) do update
    set custody_mode = excluded.custody_mode,
        cluster = excluded.cluster,
        genesis_hash = excluded.genesis_hash,
        program_id = excluded.program_id,
        custody_version = excluded.custody_version,
        enabled_by = excluded.enabled_by,
        updated_at = excluded.updated_at
    returning * into v_result;
  end if;

  return jsonb_build_object(
    'ok', true,
    'created', v_created,
    'group_id', v_result.group_id,
    'custody_mode', v_result.custody_mode,
    'cluster', v_result.cluster,
    'genesis_hash', v_result.genesis_hash,
    'program_id', v_result.program_id,
    'custody_version', v_result.custody_version,
    'enabled_by', v_result.enabled_by,
    'updated_at', v_result.updated_at
  );
end;
$$;

create function public.escrow_get_group_rollout(p_group_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_rollout public.escrow_group_rollouts%rowtype;
begin
  if p_group_id <= 0 then
    raise exception 'escrow_group_rollout_input_invalid';
  end if;
  select * into v_rollout
  from public.escrow_group_rollouts
  where group_id = p_group_id;
  if v_rollout.group_id is null then
    return jsonb_build_object('ok', true, 'found', false);
  end if;
  return jsonb_build_object(
    'ok', true,
    'found', true,
    'group_id', v_rollout.group_id,
    'custody_mode', v_rollout.custody_mode,
    'cluster', v_rollout.cluster,
    'genesis_hash', v_rollout.genesis_hash,
    'program_id', v_rollout.program_id,
    'custody_version', v_rollout.custody_version,
    'enabled_by', v_rollout.enabled_by,
    'updated_at', v_rollout.updated_at
  );
end;
$$;

-- Replace the 0024 guard forward-only. Initialization jobs bind genesis from
-- their immutable payload; linked jobs bind the complete rollout identity to
-- the immutable market link, including the genesis omitted by 0024.
create or replace function public.escrow_validate_relayer_job_custody()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_mode text;
  v_group_id bigint;
  v_link public.escrow_market_links%rowtype;
  v_rollout public.escrow_group_rollouts%rowtype;
begin
  if new.custody_mode <> 'escrow' then
    raise exception 'escrow_relayer_custody_mode_required';
  end if;
  if new.market_id is null then
    return new;
  end if;

  select custody_mode, group_id into v_mode, v_group_id
  from public.markets where id = new.market_id;
  if v_mode is distinct from 'escrow' then
    raise exception 'escrow_relayer_market_mode_mismatch';
  end if;
  select * into v_rollout
  from public.escrow_group_rollouts
  where group_id = v_group_id;

  select * into v_link
  from public.escrow_market_links
  where market_id = new.market_id;
  if v_link.market_id is null then
    if new.kind <> 'market_initialization' then
      raise exception 'escrow_relayer_market_link_missing';
    end if;
    if v_rollout.group_id is null
       or v_rollout.custody_mode <> 'escrow'
       or v_rollout.cluster is distinct from new.cluster
       or v_rollout.program_id is distinct from new.program_id
       or v_rollout.custody_version is distinct from new.custody_version
       or v_rollout.cluster is distinct from new.payload ->> 'cluster'
       or v_rollout.genesis_hash is distinct from new.payload ->> 'genesisHash'
       or v_rollout.program_id is distinct from new.payload ->> 'programId' then
      raise exception 'escrow_relayer_group_rollout_mismatch';
    end if;
    return new;
  end if;

  if v_link.custody_mode <> new.custody_mode
     or v_link.custody_version <> new.custody_version
     or v_link.cluster <> new.cluster
     or v_link.program_id <> new.program_id then
    raise exception 'escrow_relayer_market_link_mismatch';
  end if;
  if v_rollout.group_id is null
     or v_rollout.custody_mode <> 'escrow'
     or v_rollout.cluster is distinct from v_link.cluster
     or v_rollout.genesis_hash is distinct from v_link.genesis_hash
     or v_rollout.program_id is distinct from v_link.program_id
     or v_rollout.custody_version is distinct from v_link.custody_version then
    raise exception 'escrow_relayer_group_rollout_mismatch';
  end if;
  return new;
end;
$$;

alter table public.escrow_chain_event_identities
  drop constraint if exists escrow_chain_event_identities_event_kind_check;
alter table public.escrow_chain_event_identities
  add constraint escrow_chain_event_identities_event_kind_check
  check (event_kind in ('market', 'position', 'settlement', 'claim', 'market_closed'));

create table public.escrow_market_close_events (
  signature          text not null,
  instruction_index  integer not null check (instruction_index >= 0),
  market_id          uuid not null references public.escrow_market_links(market_id),
  cluster            text not null check (cluster in ('localnet', 'devnet', 'mainnet-beta')),
  genesis_hash       text not null check (genesis_hash <> ''),
  program_id         text not null check (program_id <> ''),
  market_pda         text not null check (market_pda <> ''),
  document_hash_hex  text not null check (document_hash_hex ~ '^[0-9A-Fa-f]{64}$'),
  asset              text not null check (asset in ('sol', 'usdc')),
  dust_amount_atomic numeric(20, 0) not null check (dust_amount_atomic >= 0),
  slot               bigint not null check (slot >= 0),
  block_time         timestamptz,
  commitment         text not null check (commitment = 'finalized'),
  observed_at        timestamptz not null,
  finalized_at       timestamptz not null,
  primary key (signature, instruction_index),
  unique (market_id),
  foreign key (signature, instruction_index)
    references public.escrow_chain_event_identities(signature, instruction_index)
);

create index escrow_market_close_events_slot_idx
  on public.escrow_market_close_events (cluster, program_id, slot);

create function public.escrow_index_market_closed(
  p_signature text,
  p_instruction_index integer,
  p_market_id uuid,
  p_cluster text,
  p_genesis_hash text,
  p_program_id text,
  p_market_pda text,
  p_document_hash_hex text,
  p_asset text,
  p_dust_amount_atomic numeric,
  p_slot bigint,
  p_block_time timestamptz,
  p_commitment text,
  p_observed_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link public.escrow_market_links%rowtype;
  v_existing public.escrow_market_close_events%rowtype;
begin
  if p_commitment <> 'finalized'
     or p_signature is null or p_signature = ''
     or p_instruction_index < 0
     or p_dust_amount_atomic < 0
     or p_slot < 0
     or p_observed_at is null then
    raise exception 'escrow_market_closed_input_invalid';
  end if;

  select * into v_link
  from public.escrow_market_links
  where market_id = p_market_id
  for update;
  if v_link.market_id is null then
    raise exception 'escrow_market_closed_market_missing';
  end if;
  if v_link.custody_mode <> 'escrow'
     or v_link.cluster is distinct from p_cluster
     or v_link.genesis_hash is distinct from p_genesis_hash
     or v_link.program_id is distinct from p_program_id
     or v_link.market_pda is distinct from p_market_pda then
    raise exception 'escrow_market_closed_deployment_mismatch';
  end if;
  if lower(v_link.document_hash_hex) is distinct from lower(p_document_hash_hex) then
    raise exception 'escrow_market_closed_document_mismatch';
  end if;
  if v_link.asset is distinct from p_asset then
    raise exception 'escrow_market_closed_asset_mismatch';
  end if;
  if v_link.commitment <> 'finalized'
     or not v_link.canonical
     or v_link.projection_stale then
    raise exception 'escrow_market_closed_projection_invalid';
  end if;

  select * into v_existing
  from public.escrow_market_close_events
  where market_id = p_market_id
  for update;
  if v_existing.market_id is not null then
    if v_existing.signature is distinct from p_signature
       or v_existing.instruction_index is distinct from p_instruction_index
       or v_existing.cluster is distinct from p_cluster
       or v_existing.genesis_hash is distinct from p_genesis_hash
       or v_existing.program_id is distinct from p_program_id
       or v_existing.market_pda is distinct from p_market_pda
       or lower(v_existing.document_hash_hex) is distinct from lower(p_document_hash_hex)
       or v_existing.asset is distinct from p_asset
       or v_existing.dust_amount_atomic is distinct from p_dust_amount_atomic
       or v_existing.slot is distinct from p_slot
       or v_existing.block_time is distinct from p_block_time then
      raise exception 'escrow_market_closed_identity_conflict';
    end if;
    if v_link.chain_state <> 'closed' then
      raise exception 'escrow_market_closed_state_conflict';
    end if;
    return jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'finalized', true
    );
  end if;

  if v_link.chain_state not in ('settled', 'voided') then
    raise exception 'escrow_market_closed_terminal_state_required';
  end if;

  perform public.escrow_assert_chain_identity(
    p_signature,
    p_instruction_index,
    p_cluster,
    p_program_id,
    'market_closed',
    p_slot,
    p_commitment,
    p_observed_at
  );

  insert into public.escrow_market_close_events (
    signature, instruction_index, market_id, cluster, genesis_hash, program_id,
    market_pda, document_hash_hex, asset, dust_amount_atomic, slot, block_time,
    commitment, observed_at, finalized_at
  ) values (
    p_signature, p_instruction_index, p_market_id, p_cluster, p_genesis_hash,
    p_program_id, p_market_pda, lower(p_document_hash_hex), p_asset,
    p_dust_amount_atomic, p_slot, p_block_time, 'finalized', p_observed_at,
    p_observed_at
  );

  update public.escrow_market_links
  set chain_state = 'closed',
      updated_at = p_observed_at
  where market_id = p_market_id
    and chain_state in ('settled', 'voided');
  if not found then
    raise exception 'escrow_market_closed_state_conflict';
  end if;

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'finalized', true
  );
end;
$$;

-- Reject common secret-bearing fields at every nesting level. Attestation
-- evidence remains service-role-only and is bounded separately below.
create function public.escrow_attestation_payload_private_safe(p_value jsonb)
returns boolean
language plpgsql
immutable
strict
set search_path = public
as $$
declare
  v_key text;
  v_child jsonb;
  v_normalized_key text;
begin
  if jsonb_typeof(p_value) = 'object' then
    for v_key, v_child in select key, value from jsonb_each(p_value)
    loop
      v_normalized_key := regexp_replace(lower(v_key), '[^a-z0-9]', '', 'g');
      if v_normalized_key = any(array[
        'secret', 'secretkey', 'privatekey', 'authtoken', 'accesstoken',
        'refreshtoken', 'signingtoken', 'bearertoken', 'rawprivateevidence',
        'mnemonic', 'seedphrase', 'password'
      ]) then
        return false;
      end if;
      if not public.escrow_attestation_payload_private_safe(v_child) then
        return false;
      end if;
    end loop;
  elsif jsonb_typeof(p_value) = 'array' then
    for v_child in select value from jsonb_array_elements(p_value)
    loop
      if not public.escrow_attestation_payload_private_safe(v_child) then
        return false;
      end if;
    end loop;
  end if;
  return true;
end;
$$;

create table public.escrow_attestation_requests (
  request_key                text primary key
                             check (request_key ~ '^[0-9A-Fa-f]{64}$'),
  operation_kind             text not null
                             check (operation_kind in ('freeze', 'unfreeze', 'invalidate', 'settle', 'void')),
  state                      text not null default 'pending'
                             check (state in ('pending', 'leased', 'signed', 'enqueued', 'completed', 'failed')),
  cluster                    text not null
                             check (cluster in ('localnet', 'devnet', 'mainnet-beta')),
  genesis_hash               text not null check (genesis_hash <> ''),
  program_id                 text not null check (program_id <> ''),
  custody_version            integer not null check (custody_version > 0),
  market_id                  uuid not null references public.escrow_market_links(market_id),
  market_pda                 text not null check (market_pda <> ''),
  document_hash_hex          text not null check (document_hash_hex ~ '^[0-9A-Fa-f]{64}$'),
  oracle_epoch               numeric(20, 0) not null check (oracle_epoch >= 0),
  event_epoch                numeric(20, 0) not null check (event_epoch >= 0),
  unsigned_payload           jsonb not null,
  unsigned_payload_hash_hex  text not null check (unsigned_payload_hash_hex ~ '^[0-9A-Fa-f]{64}$'),
  signed_payload             jsonb,
  signed_payload_hash_hex    text check (
                               signed_payload_hash_hex is null
                               or signed_payload_hash_hex ~ '^[0-9A-Fa-f]{64}$'
                             ),
  due_at                     timestamptz not null,
  debounce_until             timestamptz not null,
  relayer_job_id             uuid references public.escrow_relayer_jobs(id),
  attempts                   integer not null default 0 check (attempts >= 0),
  max_attempts               integer not null check (max_attempts > 0),
  lease_duration_ms          integer not null
                             check (lease_duration_ms between 1000 and 600000),
  lease_owner                text,
  lease_token                uuid,
  leased_at                  timestamptz,
  lease_expires_at           timestamptz,
  error_code                 text check (error_code is null or length(error_code) between 1 and 128),
  created_at                 timestamptz not null,
  updated_at                 timestamptz not null,
  signed_at                  timestamptz,
  enqueued_at                timestamptz,
  completed_at               timestamptz,
  failed_at                  timestamptz,
  unique (cluster, program_id, market_id, operation_kind, unsigned_payload_hash_hex),
  check (
    jsonb_typeof(unsigned_payload) = 'object'
    and pg_column_size(unsigned_payload) <= 65536
    and public.escrow_attestation_payload_private_safe(unsigned_payload)
  ),
  check (
    (signed_payload is null and signed_payload_hash_hex is null and signed_at is null)
    or (
      signed_payload is not null
      and signed_payload_hash_hex is not null
      and signed_at is not null
      and jsonb_typeof(signed_payload) = 'object'
      and pg_column_size(signed_payload) <= 65536
      and public.escrow_attestation_payload_private_safe(signed_payload)
    )
  ),
  check (
    (lease_owner is null and lease_token is null and leased_at is null and lease_expires_at is null)
    or (lease_owner is not null and lease_token is not null and leased_at is not null and lease_expires_at is not null)
  ),
  check (
    (relayer_job_id is null and enqueued_at is null)
    or (relayer_job_id is not null and enqueued_at is not null)
  ),
  check (state not in ('signed', 'enqueued', 'completed') or signed_payload is not null),
  check (state not in ('enqueued', 'completed') or relayer_job_id is not null),
  check ((state = 'completed') = (completed_at is not null)),
  check ((state = 'failed') = (failed_at is not null))
);

create index escrow_attestation_requests_ready_idx
  on public.escrow_attestation_requests (state, debounce_until, due_at);
create index escrow_attestation_requests_market_idx
  on public.escrow_attestation_requests (market_id, operation_kind, created_at);
create index escrow_attestation_requests_relayer_idx
  on public.escrow_attestation_requests (relayer_job_id)
  where relayer_job_id is not null;

create function public.escrow_attestation_relayer_kind(p_operation_kind text)
returns text
language sql
immutable
strict
set search_path = public
as $$
  select case p_operation_kind
    when 'freeze' then 'freeze'
    when 'unfreeze' then 'unfreeze'
    when 'invalidate' then 'position_invalidation'
    when 'settle' then 'settlement_submission'
    when 'void' then 'settlement_submission'
    else null
  end;
$$;

create function public.escrow_attestation_enqueue(
  p_request_key text,
  p_operation_kind text,
  p_cluster text,
  p_genesis_hash text,
  p_program_id text,
  p_custody_version integer,
  p_market_id uuid,
  p_market_pda text,
  p_document_hash_hex text,
  p_oracle_epoch numeric,
  p_event_epoch numeric,
  p_unsigned_payload jsonb,
  p_unsigned_payload_hash_hex text,
  p_due_at timestamptz,
  p_debounce_until timestamptz,
  p_max_attempts integer,
  p_lease_ms integer,
  p_now timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.escrow_attestation_requests%rowtype;
  v_alias public.escrow_attestation_requests%rowtype;
  v_link public.escrow_market_links%rowtype;
  v_debounce_until timestamptz := coalesce(p_debounce_until, p_due_at);
begin
  if p_request_key !~ '^[0-9A-Fa-f]{64}$'
     or p_operation_kind not in ('freeze', 'unfreeze', 'invalidate', 'settle', 'void')
     or p_custody_version <= 0
     or p_oracle_epoch < 0
     or p_event_epoch < 0
     or p_unsigned_payload_hash_hex !~ '^[0-9A-Fa-f]{64}$'
     or jsonb_typeof(p_unsigned_payload) <> 'object'
     or pg_column_size(p_unsigned_payload) > 65536
     or not public.escrow_attestation_payload_private_safe(p_unsigned_payload)
     or p_max_attempts <= 0
     or p_lease_ms < 1000 or p_lease_ms > 600000
     or p_due_at is null
     or p_now is null then
    raise exception 'escrow_attestation_input_invalid';
  end if;

  select * into v_existing
  from public.escrow_attestation_requests
  where request_key = lower(p_request_key)
  for update;
  if v_existing.request_key is not null then
    if v_existing.operation_kind is distinct from p_operation_kind
       or v_existing.cluster is distinct from p_cluster
       or v_existing.genesis_hash is distinct from p_genesis_hash
       or v_existing.program_id is distinct from p_program_id
       or v_existing.custody_version is distinct from p_custody_version
       or v_existing.market_id is distinct from p_market_id
       or v_existing.market_pda is distinct from p_market_pda
       or lower(v_existing.document_hash_hex) is distinct from lower(p_document_hash_hex)
       or v_existing.oracle_epoch is distinct from p_oracle_epoch
       or v_existing.event_epoch is distinct from p_event_epoch
       or v_existing.unsigned_payload is distinct from p_unsigned_payload
       or lower(v_existing.unsigned_payload_hash_hex) is distinct from lower(p_unsigned_payload_hash_hex)
       or v_existing.due_at is distinct from p_due_at
       or v_existing.debounce_until is distinct from v_debounce_until
       or v_existing.max_attempts is distinct from p_max_attempts
       or v_existing.lease_duration_ms is distinct from p_lease_ms then
      raise exception 'escrow_attestation_idempotency_conflict';
    end if;
    return jsonb_build_object(
      'ok', true,
      'created', false,
      'request_key', v_existing.request_key
    );
  end if;

  select * into v_alias
  from public.escrow_attestation_requests
  where cluster = p_cluster
    and program_id = p_program_id
    and market_id = p_market_id
    and operation_kind = p_operation_kind
    and lower(unsigned_payload_hash_hex) = lower(p_unsigned_payload_hash_hex)
  for update;
  if v_alias.request_key is not null then
    raise exception 'escrow_attestation_idempotency_conflict';
  end if;

  select * into v_link
  from public.escrow_market_links
  where market_id = p_market_id
  for update;
  if v_link.market_id is null then
    raise exception 'escrow_attestation_market_missing';
  end if;
  if v_link.custody_mode <> 'escrow'
     or v_link.custody_version is distinct from p_custody_version
     or v_link.cluster is distinct from p_cluster
     or v_link.genesis_hash is distinct from p_genesis_hash
     or v_link.program_id is distinct from p_program_id
     or v_link.market_pda is distinct from p_market_pda
     or lower(v_link.document_hash_hex) is distinct from lower(p_document_hash_hex)
     or v_link.oracle_epoch is distinct from p_oracle_epoch
     or v_link.event_epoch is distinct from p_event_epoch then
    raise exception 'escrow_attestation_binding_mismatch';
  end if;
  if v_link.commitment <> 'finalized'
     or not v_link.canonical
     or v_link.projection_stale
     or v_link.chain_state not in ('open', 'frozen') then
    raise exception 'escrow_attestation_market_state_invalid';
  end if;

  insert into public.escrow_attestation_requests (
    request_key, operation_kind, cluster, genesis_hash, program_id,
    custody_version, market_id, market_pda, document_hash_hex, oracle_epoch,
    event_epoch, unsigned_payload, unsigned_payload_hash_hex, due_at,
    debounce_until, max_attempts, lease_duration_ms, created_at, updated_at
  ) values (
    lower(p_request_key), p_operation_kind, p_cluster, p_genesis_hash,
    p_program_id, p_custody_version, p_market_id, p_market_pda,
    lower(p_document_hash_hex), p_oracle_epoch, p_event_epoch,
    p_unsigned_payload, lower(p_unsigned_payload_hash_hex), p_due_at,
    v_debounce_until, p_max_attempts, p_lease_ms, p_now, p_now
  );

  return jsonb_build_object(
    'ok', true,
    'created', true,
    'request_key', lower(p_request_key)
  );
end;
$$;

create function public.escrow_attestation_lease(
  p_worker_id text,
  p_now timestamptz,
  p_limit integer
) returns setof public.escrow_attestation_requests
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_worker_id is null or p_worker_id = '' or length(p_worker_id) > 128
     or p_now is null or p_limit < 1 or p_limit > 100 then
    raise exception 'escrow_attestation_lease_input_invalid';
  end if;

  update public.escrow_attestation_requests requests
  set state = 'failed',
      error_code = coalesce(requests.error_code, 'attempts_exhausted'),
      failed_at = p_now,
      lease_owner = null,
      lease_token = null,
      leased_at = null,
      lease_expires_at = null,
      updated_at = p_now
  where requests.state not in ('completed', 'failed')
    and requests.attempts >= requests.max_attempts
    and requests.debounce_until <= p_now
    and (
      (requests.state in ('pending', 'signed', 'enqueued') and requests.due_at <= p_now)
      or (requests.state = 'leased' and requests.lease_expires_at <= p_now)
    );

  return query
  with candidates as (
    select requests.request_key
    from public.escrow_attestation_requests requests
    where requests.attempts < requests.max_attempts
      and requests.debounce_until <= p_now
      and (
        (requests.state in ('pending', 'signed', 'enqueued') and requests.due_at <= p_now)
        or (requests.state = 'leased' and requests.lease_expires_at <= p_now)
      )
    order by greatest(requests.due_at, requests.debounce_until), requests.created_at,
             requests.request_key
    for update skip locked
    limit p_limit
  )
  update public.escrow_attestation_requests requests
  set state = 'leased',
      attempts = requests.attempts + 1,
      lease_owner = p_worker_id,
      lease_token = gen_random_uuid(),
      leased_at = p_now,
      lease_expires_at = p_now + make_interval(secs => requests.lease_duration_ms / 1000.0),
      updated_at = p_now
  from candidates
  where requests.request_key = candidates.request_key
  returning requests.*;
end;
$$;

create function public.escrow_attestation_record_signed(
  p_request_key text,
  p_worker_id text,
  p_lease_token uuid,
  p_now timestamptz,
  p_signed_payload jsonb,
  p_signed_payload_hash_hex text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.escrow_attestation_requests%rowtype;
begin
  select * into v_request
  from public.escrow_attestation_requests
  where request_key = lower(p_request_key)
  for update;
  if v_request.request_key is null then
    return jsonb_build_object('ok', false, 'code', 'request_not_found');
  end if;
  if v_request.lease_owner is distinct from p_worker_id
     or v_request.lease_token is distinct from p_lease_token
     or v_request.lease_expires_at <= p_now then
    return jsonb_build_object('ok', false, 'code', 'lease_lost');
  end if;
  if v_request.state not in ('leased', 'signed') then
    return jsonb_build_object('ok', false, 'code', 'state_conflict');
  end if;
  if p_signed_payload_hash_hex !~ '^[0-9A-Fa-f]{64}$'
     or jsonb_typeof(p_signed_payload) <> 'object'
     or pg_column_size(p_signed_payload) > 65536
     or not public.escrow_attestation_payload_private_safe(p_signed_payload) then
    return jsonb_build_object('ok', false, 'code', 'payload_mismatch');
  end if;

  if v_request.signed_payload is not null then
    if v_request.signed_payload is distinct from p_signed_payload
       or lower(v_request.signed_payload_hash_hex) is distinct from lower(p_signed_payload_hash_hex) then
      return jsonb_build_object('ok', false, 'code', 'payload_mismatch');
    end if;
    update public.escrow_attestation_requests
    set state = 'signed',
        due_at = lease_expires_at,
        updated_at = p_now
    where request_key = v_request.request_key;
    return jsonb_build_object('ok', true, 'duplicate', true, 'state', 'signed');
  end if;

  update public.escrow_attestation_requests
  set state = 'signed',
      signed_payload = p_signed_payload,
      signed_payload_hash_hex = lower(p_signed_payload_hash_hex),
      signed_at = p_now,
      due_at = lease_expires_at,
      error_code = null,
      updated_at = p_now
  where request_key = v_request.request_key;
  return jsonb_build_object('ok', true, 'duplicate', false, 'state', 'signed');
end;
$$;

create function public.escrow_attestation_mark_enqueued(
  p_request_key text,
  p_worker_id text,
  p_lease_token uuid,
  p_now timestamptz,
  p_relayer_job_id uuid,
  p_next_check_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.escrow_attestation_requests%rowtype;
  v_job public.escrow_relayer_jobs%rowtype;
  v_expected_kind text;
begin
  select * into v_request
  from public.escrow_attestation_requests
  where request_key = lower(p_request_key)
  for update;
  if v_request.request_key is null then
    return jsonb_build_object('ok', false, 'code', 'request_not_found');
  end if;
  if v_request.lease_owner is distinct from p_worker_id
     or v_request.lease_token is distinct from p_lease_token
     or v_request.lease_expires_at <= p_now then
    return jsonb_build_object('ok', false, 'code', 'lease_lost');
  end if;
  if v_request.state not in ('leased', 'signed', 'enqueued')
     or v_request.signed_payload is null
     or p_next_check_at < p_now then
    return jsonb_build_object('ok', false, 'code', 'state_conflict');
  end if;
  if v_request.relayer_job_id is not null
     and v_request.relayer_job_id is distinct from p_relayer_job_id then
    return jsonb_build_object('ok', false, 'code', 'relayer_mismatch');
  end if;

  select * into v_job
  from public.escrow_relayer_jobs
  where id = p_relayer_job_id
  for update;
  v_expected_kind := public.escrow_attestation_relayer_kind(v_request.operation_kind);
  if v_job.id is null
     or v_job.kind is distinct from v_expected_kind
     or v_job.cluster is distinct from v_request.cluster
     or v_job.program_id is distinct from v_request.program_id
     or v_job.custody_mode <> 'escrow'
     or v_job.custody_version is distinct from v_request.custody_version
     or v_job.market_id is distinct from v_request.market_id
     or v_job.state = 'dead' then
    return jsonb_build_object('ok', false, 'code', 'relayer_mismatch');
  end if;

  if v_request.relayer_job_id = p_relayer_job_id then
    update public.escrow_attestation_requests
    set state = 'enqueued',
        due_at = p_next_check_at,
        updated_at = p_now
    where request_key = v_request.request_key;
    return jsonb_build_object('ok', true, 'duplicate', true, 'state', 'enqueued');
  end if;

  update public.escrow_attestation_requests
  set state = 'enqueued',
      relayer_job_id = p_relayer_job_id,
      enqueued_at = p_now,
      due_at = p_next_check_at,
      error_code = null,
      updated_at = p_now
  where request_key = v_request.request_key;
  return jsonb_build_object('ok', true, 'duplicate', false, 'state', 'enqueued');
end;
$$;

create function public.escrow_attestation_complete(
  p_request_key text,
  p_worker_id text,
  p_lease_token uuid,
  p_now timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.escrow_attestation_requests%rowtype;
  v_job public.escrow_relayer_jobs%rowtype;
begin
  select * into v_request
  from public.escrow_attestation_requests
  where request_key = lower(p_request_key)
  for update;
  if v_request.request_key is null then
    return jsonb_build_object('ok', false, 'code', 'request_not_found');
  end if;
  if v_request.lease_owner is distinct from p_worker_id
     or v_request.lease_token is distinct from p_lease_token
     or v_request.lease_expires_at <= p_now then
    return jsonb_build_object('ok', false, 'code', 'lease_lost');
  end if;
  if v_request.state not in ('leased', 'enqueued')
     or v_request.relayer_job_id is null then
    return jsonb_build_object('ok', false, 'code', 'state_conflict');
  end if;

  select * into v_job
  from public.escrow_relayer_jobs
  where id = v_request.relayer_job_id
  for update;
  if v_job.id is null
     or v_job.state <> 'complete'
     or v_job.cluster is distinct from v_request.cluster
     or v_job.program_id is distinct from v_request.program_id
     or v_job.custody_mode <> 'escrow'
     or v_job.custody_version is distinct from v_request.custody_version
     or v_job.market_id is distinct from v_request.market_id then
    return jsonb_build_object('ok', false, 'code', 'relayer_mismatch');
  end if;

  update public.escrow_attestation_requests
  set state = 'completed',
      completed_at = p_now,
      lease_owner = null,
      lease_token = null,
      leased_at = null,
      lease_expires_at = null,
      error_code = null,
      updated_at = p_now
  where request_key = v_request.request_key;
  return jsonb_build_object('ok', true, 'duplicate', false, 'state', 'completed');
end;
$$;

create function public.escrow_attestation_retry(
  p_request_key text,
  p_worker_id text,
  p_lease_token uuid,
  p_now timestamptz,
  p_error_code text,
  p_retry_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.escrow_attestation_requests%rowtype;
  v_next_state text;
begin
  select * into v_request
  from public.escrow_attestation_requests
  where request_key = lower(p_request_key)
  for update;
  if v_request.request_key is null then
    return jsonb_build_object('ok', false, 'code', 'request_not_found');
  end if;
  if v_request.lease_owner is distinct from p_worker_id
     or v_request.lease_token is distinct from p_lease_token
     or v_request.lease_expires_at <= p_now then
    return jsonb_build_object('ok', false, 'code', 'lease_lost');
  end if;
  if v_request.state not in ('leased', 'signed', 'enqueued')
     or p_error_code is null or length(p_error_code) not between 1 and 128
     or p_retry_at < p_now then
    return jsonb_build_object('ok', false, 'code', 'state_conflict');
  end if;

  if v_request.attempts >= v_request.max_attempts then
    update public.escrow_attestation_requests
    set state = 'failed',
        failed_at = p_now,
        error_code = p_error_code,
        lease_owner = null,
        lease_token = null,
        leased_at = null,
        lease_expires_at = null,
        updated_at = p_now
    where request_key = v_request.request_key;
    return jsonb_build_object('ok', true, 'duplicate', false, 'state', 'failed');
  end if;

  v_next_state := case
    when v_request.relayer_job_id is not null then 'enqueued'
    when v_request.signed_payload is not null then 'signed'
    else 'pending'
  end;
  update public.escrow_attestation_requests
  set state = v_next_state,
      due_at = p_retry_at,
      error_code = p_error_code,
      lease_owner = null,
      lease_token = null,
      leased_at = null,
      lease_expires_at = null,
      updated_at = p_now
  where request_key = v_request.request_key;
  return jsonb_build_object('ok', true, 'duplicate', false, 'state', v_next_state);
end;
$$;

-- Both projections contain private operational state only. Public receipts
-- continue to read the aggregate-safe 0025 view unchanged.
alter table public.escrow_market_close_events enable row level security;
alter table public.escrow_attestation_requests enable row level security;

revoke all privileges on table
  public.escrow_market_close_events,
  public.escrow_attestation_requests
from public, anon, authenticated;

grant select, insert, update, delete on table
  public.escrow_market_close_events,
  public.escrow_attestation_requests
to service_role;

do $$
declare
  v_function record;
begin
  for v_function in
    select n.nspname as schema_name, p.proname as function_name,
           pg_get_function_identity_arguments(p.oid) as identity_arguments
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'escrow_assign_market_custody_from_rollout',
        'escrow_configure_group_rollout',
        'escrow_get_group_rollout',
        'escrow_validate_relayer_job_custody',
        'escrow_index_market_closed',
        'escrow_attestation_payload_private_safe',
        'escrow_attestation_relayer_kind',
        'escrow_attestation_enqueue',
        'escrow_attestation_lease',
        'escrow_attestation_record_signed',
        'escrow_attestation_mark_enqueued',
        'escrow_attestation_complete',
        'escrow_attestation_retry'
      )
  loop
    execute format(
      'revoke all privileges on function %I.%I(%s) from public, anon, authenticated',
      v_function.schema_name, v_function.function_name, v_function.identity_arguments
    );
    execute format(
      'grant execute on function %I.%I(%s) to service_role',
      v_function.schema_name, v_function.function_name, v_function.identity_arguments
    );
  end loop;
end;
$$;
