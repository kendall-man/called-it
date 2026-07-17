-- A signed relayer job still holds its lease after escrow_relayer_record_signed.
-- Broadcast can be unknown (or readiness can close) before mark_submitted, so the
-- retry transition must accept both leased and signed jobs under the same fence.
create or replace function public.escrow_relayer_retry(
  p_job_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_now timestamptz,
  p_error_code text,
  p_retry_at timestamptz,
  p_confirmation_unknown boolean,
  p_full_history_checked_at timestamptz,
  p_current_block_height bigint
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.escrow_relayer_jobs%rowtype;
  v_next_state text;
begin
  select * into v_job from public.escrow_relayer_jobs where id = p_job_id for update;
  if v_job.id is null then
    return jsonb_build_object('ok', false, 'code', 'job_not_found');
  end if;
  if v_job.lease_owner is distinct from p_worker_id or v_job.lease_token is distinct from p_lease_token then
    return jsonb_build_object('ok', false, 'code', 'lease_lost');
  end if;
  if v_job.state not in ('leased', 'signed') then
    return jsonb_build_object('ok', false, 'code', 'state_conflict');
  end if;

  if p_confirmation_unknown then
    v_next_state := 'unknown';
  else
    if v_job.raw_transaction is not null and (
      p_full_history_checked_at is null
      or p_current_block_height is null
      or p_current_block_height <= v_job.last_valid_block_height
    ) then
      return jsonb_build_object('ok', false, 'code', 'state_conflict');
    end if;
    v_next_state := 'retry_wait';
  end if;

  update public.escrow_relayer_jobs
  set state = v_next_state,
      due_at = p_retry_at,
      error_code = p_error_code,
      full_history_checked_at = case
        when p_confirmation_unknown then full_history_checked_at
        else p_full_history_checked_at
      end,
      raw_transaction = case when p_confirmation_unknown then raw_transaction else null end,
      expected_signature = case when p_confirmation_unknown then expected_signature else null end,
      transaction_message_hash_hex = case when p_confirmation_unknown then transaction_message_hash_hex else null end,
      last_valid_block_height = case when p_confirmation_unknown then last_valid_block_height else null end,
      submitted_at = case when p_confirmation_unknown then submitted_at else null end,
      lease_owner = null,
      lease_token = null,
      leased_at = null,
      lease_expires_at = null,
      updated_at = p_now
  where id = p_job_id;
  return jsonb_build_object('ok', true, 'duplicate', false, 'state', v_next_state);
end;
$$;
