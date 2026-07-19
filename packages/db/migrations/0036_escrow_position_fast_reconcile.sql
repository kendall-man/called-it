-- User-signed placement transactions arrive with less remaining blockhash life
-- than server-signed escrow jobs. Reconcile an ambiguous placement broadcast
-- promptly so transient RPC throttling cannot consume the remaining validity.
-- The relayer still checks the exact signature and chain state before every
-- rebroadcast; all other escrow jobs retain the original 20-second quarantine.

create or replace function public.escrow_relayer_mark_submitted(
  p_job_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_now timestamptz,
  p_expected_signature text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.escrow_relayer_jobs%rowtype;
begin
  select * into v_job from public.escrow_relayer_jobs where id = p_job_id for update;
  if v_job.id is null then
    return jsonb_build_object('ok', false, 'code', 'job_not_found');
  end if;
  if v_job.lease_owner is distinct from p_worker_id or v_job.lease_token is distinct from p_lease_token then
    return jsonb_build_object('ok', false, 'code', 'lease_lost');
  end if;
  if v_job.expected_signature is distinct from p_expected_signature then
    return jsonb_build_object('ok', false, 'code', 'signature_mismatch');
  end if;
  if v_job.state = 'submitted' then
    return jsonb_build_object('ok', true, 'duplicate', true, 'state', 'submitted');
  end if;
  if v_job.state <> 'signed' then
    return jsonb_build_object('ok', false, 'code', 'state_conflict');
  end if;

  update public.escrow_relayer_jobs
  set state = 'submitted',
      submitted_at = coalesce(submitted_at, p_now),
      due_at = p_now + case
        when v_job.kind = 'position_placement' then interval '1 second'
        else interval '20 seconds'
      end,
      updated_at = p_now
  where id = p_job_id;
  return jsonb_build_object('ok', true, 'duplicate', false, 'state', 'submitted');
end;
$$;
