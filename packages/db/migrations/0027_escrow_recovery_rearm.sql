-- Rearm exhausted deterministic recovery work when no transaction can have
-- produced an economic effect. The idempotency key and job row are retained.
create or replace function public.escrow_relayer_enqueue(
  p_kind text,
  p_idempotency_key text,
  p_cluster text,
  p_program_id text,
  p_custody_mode text,
  p_custody_version integer,
  p_market_id uuid,
  p_owner_pubkey text,
  p_payload jsonb,
  p_due_at timestamptz,
  p_max_attempts integer,
  p_lease_ms integer,
  p_now timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.escrow_relayer_jobs%rowtype;
  v_job_id uuid;
begin
  if p_custody_mode <> 'escrow'
     or p_custody_version <= 0
     or p_max_attempts <= 0
     or p_lease_ms < 1000 or p_lease_ms > 600000 then
    raise exception 'escrow_relayer_queue_policy_invalid';
  end if;

  select * into v_existing
  from public.escrow_relayer_jobs
  where idempotency_key = p_idempotency_key
  for update;
  if v_existing.id is not null then
    if v_existing.kind is distinct from p_kind
       or v_existing.cluster is distinct from p_cluster
       or v_existing.program_id is distinct from p_program_id
       or v_existing.custody_mode is distinct from p_custody_mode
       or v_existing.custody_version is distinct from p_custody_version
       or v_existing.market_id is distinct from p_market_id
       or v_existing.owner_pubkey is distinct from p_owner_pubkey
       or v_existing.payload is distinct from coalesce(p_payload, '{}'::jsonb) then
      raise exception 'escrow_relayer_idempotency_conflict';
    end if;

    if v_existing.kind in (
         'settlement_submission', 'timeout_monitoring', 'auto_claim', 'account_close'
       )
       and v_existing.kind <> 'position_placement'
       and v_existing.state <> 'complete'
       and v_existing.completed_at is null
       and v_existing.confirmed_at is null
       and (
         v_existing.state = 'dead'
         or v_existing.attempts >= v_existing.max_attempts
       )
       and (
         v_existing.state <> 'leased'
         or v_existing.lease_expires_at <= p_now
       )
       and v_existing.raw_transaction is null
       and v_existing.expected_signature is null
       and v_existing.transaction_message_hash_hex is null
       and v_existing.last_valid_block_height is null
       and v_existing.submitted_at is null
       and not exists (
         select 1
         from public.escrow_chain_event_identities effect
         where effect.signature = v_existing.expected_signature
           and effect.canonical
           and effect.commitment in ('confirmed', 'finalized')
       ) then
      update public.escrow_relayer_jobs
      set state = 'pending',
          attempts = 0,
          due_at = p_due_at,
          lease_owner = null,
          lease_token = null,
          leased_at = null,
          lease_expires_at = null,
          full_history_checked_at = null,
          dead_at = null,
          error_code = left(
            'rearmed_after_exhaustion:' || coalesce(v_existing.error_code, 'unspecified'),
            128
          ),
          updated_at = p_now
      where id = v_existing.id;
    end if;

    return jsonb_build_object('ok', true, 'created', false, 'job_id', v_existing.id);
  end if;

  insert into public.escrow_relayer_jobs (
    kind, idempotency_key, cluster, program_id, custody_mode, custody_version,
    market_id, owner_pubkey, payload, max_attempts, lease_duration_ms,
    due_at, created_at, updated_at
  ) values (
    p_kind, p_idempotency_key, p_cluster, p_program_id, p_custody_mode, p_custody_version,
    p_market_id, p_owner_pubkey, coalesce(p_payload, '{}'::jsonb), p_max_attempts, p_lease_ms,
    p_due_at, p_now, p_now
  ) returning id into v_job_id;

  return jsonb_build_object('ok', true, 'created', true, 'job_id', v_job_id);
end;
$$;
