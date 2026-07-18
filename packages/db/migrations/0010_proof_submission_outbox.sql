begin;

create table proof_submission_outbox (
  market_id               uuid not null references markets(id),
  attempt                 integer not null check (attempt between 1 and 100),
  state                   text not null check (state in ('prepared', 'broadcast', 'landed', 'expired')),
  signature               text not null check (char_length(signature) between 32 and 128 and btrim(signature) <> ''),
  raw_tx_b64              text not null check (char_length(raw_tx_b64) between 8 and 16384 and btrim(raw_tx_b64) <> ''),
  last_valid_block_height bigint not null check (last_valid_block_height > 0),
  proof_payload           jsonb not null check (jsonb_typeof(proof_payload) = 'object'),
  broadcast_count         integer not null default 0 check (broadcast_count >= 0),
  prepared_at             timestamptz not null,
  last_broadcast_at       timestamptz,
  landed_at               timestamptz,
  expired_at              timestamptz,
  updated_at              timestamptz not null,
  primary key (market_id, attempt),
  unique (signature),
  check (
    (state = 'prepared'
      and broadcast_count = 0
      and last_broadcast_at is null
      and landed_at is null
      and expired_at is null)
    or (state = 'broadcast'
      and broadcast_count >= 1
      and last_broadcast_at is not null
      and landed_at is null
      and expired_at is null)
    or (state = 'landed'
      and landed_at is not null
      and expired_at is null)
    or (state = 'expired'
      and landed_at is null
      and expired_at is not null)
  )
);

create index proof_submission_outbox_recovery_idx
  on proof_submission_outbox (market_id, attempt desc);

alter table proof_submission_outbox enable row level security;
revoke all privileges on table proof_submission_outbox from public, anon, authenticated, service_role;

create function proof_submission_get(p_market_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_outbox proof_submission_outbox%rowtype;
begin
  if p_market_id is null then
    return jsonb_build_object('ok', false, 'code', 'market_not_found');
  end if;

  select * into v_outbox
  from proof_submission_outbox
  where market_id = p_market_id
  order by attempt desc
  limit 1;

  return jsonb_build_object('ok', true, 'outbox', case when found then to_jsonb(v_outbox) else null end);
end;
$$;

create function proof_submission_prepare(
  p_market_id uuid,
  p_signature text,
  p_raw_tx_b64 text,
  p_last_valid_block_height bigint,
  p_proof_payload jsonb,
  p_now timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_market markets%rowtype;
  v_outbox proof_submission_outbox%rowtype;
  v_attempt integer;
begin
  if p_market_id is null
     or p_signature is null
     or p_raw_tx_b64 is null
     or p_last_valid_block_height is null
     or p_proof_payload is null
     or p_now is null
     or char_length(p_signature) not between 32 and 128
     or char_length(p_raw_tx_b64) not between 8 and 16384
     or btrim(p_signature) = ''
     or btrim(p_raw_tx_b64) = ''
     or p_last_valid_block_height <= 0
     or jsonb_typeof(p_proof_payload) <> 'object' then
    return jsonb_build_object('ok', false, 'code', 'submission_identity_conflict');
  end if;

  select * into v_market from markets where id = p_market_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'market_not_found');
  end if;
  if not exists (
    select 1 from proofs
    where market_id = p_market_id and kind = 'stat' and status = 'pending'
  ) then
    return jsonb_build_object('ok', false, 'code', 'proof_not_pending');
  end if;

  select * into v_outbox
  from proof_submission_outbox
  where market_id = p_market_id
  order by attempt desc
  limit 1
  for update;

  if found and v_outbox.state <> 'expired' then
    if v_outbox.signature = p_signature
       and v_outbox.raw_tx_b64 = p_raw_tx_b64
       and v_outbox.last_valid_block_height = p_last_valid_block_height
       and v_outbox.proof_payload = p_proof_payload then
      return jsonb_build_object('ok', true, 'duplicate', true, 'outbox', to_jsonb(v_outbox));
    end if;
    return jsonb_build_object('ok', false, 'code', 'submission_identity_conflict');
  end if;

  v_attempt := case when found then v_outbox.attempt + 1 else 1 end;
  insert into proof_submission_outbox (
    market_id, attempt, state, signature, raw_tx_b64, last_valid_block_height,
    proof_payload, broadcast_count, prepared_at, updated_at
  ) values (
    p_market_id, v_attempt, 'prepared', p_signature, p_raw_tx_b64, p_last_valid_block_height,
    p_proof_payload, 0, p_now, p_now
  ) returning * into v_outbox;

  return jsonb_build_object('ok', true, 'duplicate', false, 'outbox', to_jsonb(v_outbox));
end;
$$;

create function proof_submission_mark_broadcast(
  p_market_id uuid,
  p_attempt integer,
  p_signature text,
  p_now timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_outbox proof_submission_outbox%rowtype;
begin
  select * into v_outbox from proof_submission_outbox
  where market_id = p_market_id and attempt = p_attempt
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'submission_not_found');
  end if;
  if p_now is null or p_signature is null or v_outbox.signature <> p_signature then
    return jsonb_build_object('ok', false, 'code', 'submission_identity_conflict');
  end if;
  if v_outbox.state = 'landed' then
    return jsonb_build_object('ok', true, 'duplicate', true, 'outbox', to_jsonb(v_outbox));
  end if;
  if v_outbox.state = 'expired' then
    return jsonb_build_object('ok', false, 'code', 'submission_not_active');
  end if;

  update proof_submission_outbox
  set state = 'broadcast',
      broadcast_count = broadcast_count + 1,
      last_broadcast_at = p_now,
      updated_at = p_now
  where market_id = p_market_id and attempt = p_attempt
  returning * into v_outbox;
  return jsonb_build_object('ok', true, 'duplicate', false, 'outbox', to_jsonb(v_outbox));
end;
$$;

create function proof_submission_mark_landed(
  p_market_id uuid,
  p_attempt integer,
  p_signature text,
  p_now timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_outbox proof_submission_outbox%rowtype;
begin
  select * into v_outbox from proof_submission_outbox
  where market_id = p_market_id and attempt = p_attempt
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'submission_not_found');
  end if;
  if p_now is null or p_signature is null or v_outbox.signature <> p_signature then
    return jsonb_build_object('ok', false, 'code', 'submission_identity_conflict');
  end if;
  if v_outbox.state = 'landed' then
    return jsonb_build_object('ok', true, 'duplicate', true, 'outbox', to_jsonb(v_outbox));
  end if;
  if v_outbox.state = 'expired' then
    return jsonb_build_object('ok', false, 'code', 'submission_not_active');
  end if;

  update proof_submission_outbox
  set state = 'landed', landed_at = p_now, updated_at = p_now
  where market_id = p_market_id and attempt = p_attempt
  returning * into v_outbox;
  return jsonb_build_object('ok', true, 'duplicate', false, 'outbox', to_jsonb(v_outbox));
end;
$$;

create function proof_submission_mark_expired(
  p_market_id uuid,
  p_attempt integer,
  p_signature text,
  p_now timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_outbox proof_submission_outbox%rowtype;
begin
  select * into v_outbox from proof_submission_outbox
  where market_id = p_market_id and attempt = p_attempt
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'submission_not_found');
  end if;
  if p_now is null or p_signature is null or v_outbox.signature <> p_signature then
    return jsonb_build_object('ok', false, 'code', 'submission_identity_conflict');
  end if;
  if v_outbox.state = 'expired' then
    return jsonb_build_object('ok', true, 'duplicate', true, 'outbox', to_jsonb(v_outbox));
  end if;
  if v_outbox.state = 'landed' then
    return jsonb_build_object('ok', false, 'code', 'submission_not_active');
  end if;

  update proof_submission_outbox
  set state = 'expired', expired_at = p_now, updated_at = p_now
  where market_id = p_market_id and attempt = p_attempt
  returning * into v_outbox;
  return jsonb_build_object('ok', true, 'duplicate', false, 'outbox', to_jsonb(v_outbox));
end;
$$;

revoke all on function
  proof_submission_get(uuid),
  proof_submission_prepare(uuid,text,text,bigint,jsonb,timestamptz),
  proof_submission_mark_broadcast(uuid,integer,text,timestamptz),
  proof_submission_mark_landed(uuid,integer,text,timestamptz),
  proof_submission_mark_expired(uuid,integer,text,timestamptz)
from public, anon, authenticated, service_role;

grant execute on function
  proof_submission_get(uuid),
  proof_submission_prepare(uuid,text,text,bigint,jsonb,timestamptz),
  proof_submission_mark_broadcast(uuid,integer,text,timestamptz),
  proof_submission_mark_landed(uuid,integer,text,timestamptz),
  proof_submission_mark_expired(uuid,integer,text,timestamptz)
to service_role;

commit;
