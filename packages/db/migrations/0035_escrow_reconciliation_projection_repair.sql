-- Reinstall the finalized reconciliation projection as a forward-only repair.
-- Production accepted reconciliation checks containing transient market state
-- while its market-link projection remained on the initialization state.
create or replace function public.escrow_record_reconciliation(
  p_market_id uuid,
  p_cluster text,
  p_program_id text,
  p_checked_slot bigint,
  p_vault_balance_atomic numeric,
  p_liability_atomic numeric,
  p_position_account_count integer,
  p_status text,
  p_details jsonb,
  p_checked_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link public.escrow_market_links%rowtype;
  v_duplicate boolean;
  v_drift numeric(21, 0);
  v_chain_state text := p_details ->> 'chainState';
  v_event_epoch numeric(20, 0);
begin
  if (v_chain_state is null) <> (p_details ->> 'eventEpoch' is null)
     or (v_chain_state is not null and (
       v_chain_state not in ('open', 'frozen', 'settled', 'voided', 'closed')
       or p_details ->> 'eventEpoch' !~ '^(0|[1-9][0-9]*)$'
     )) then
    raise exception 'escrow_reconciliation_market_state_invalid';
  end if;
  if v_chain_state is not null then
    v_event_epoch := (p_details ->> 'eventEpoch')::numeric(20, 0);
  end if;

  select * into v_link from public.escrow_market_links
  where market_id = p_market_id
  for update;
  if v_link.market_id is null
     or v_link.cluster is distinct from p_cluster
     or v_link.program_id is distinct from p_program_id
     or v_link.custody_mode <> 'escrow' then
    raise exception 'escrow_reconciliation_market_mismatch';
  end if;
  if p_status = 'in_sync' and p_vault_balance_atomic <> p_liability_atomic then
    raise exception 'escrow_reconciliation_false_sync';
  end if;
  if p_status = 'drift' and p_vault_balance_atomic = p_liability_atomic then
    raise exception 'escrow_reconciliation_false_drift';
  end if;

  v_drift := p_vault_balance_atomic - p_liability_atomic;
  select exists (
    select 1 from public.escrow_reconciliation_checks
    where market_id = p_market_id and checked_slot = p_checked_slot
  ) into v_duplicate;

  insert into public.escrow_reconciliation_checks (
    market_id, checked_slot, cluster, program_id, vault_balance_atomic,
    liability_atomic, drift_atomic, position_account_count, status, details, checked_at
  ) values (
    p_market_id, p_checked_slot, p_cluster, p_program_id, p_vault_balance_atomic,
    p_liability_atomic, v_drift, p_position_account_count, p_status,
    coalesce(p_details, '{}'::jsonb), p_checked_at
  ) on conflict (market_id, checked_slot) do update
  set vault_balance_atomic = excluded.vault_balance_atomic,
      liability_atomic = excluded.liability_atomic,
      drift_atomic = excluded.drift_atomic,
      position_account_count = excluded.position_account_count,
      status = excluded.status,
      details = excluded.details,
      checked_at = excluded.checked_at
  where public.escrow_reconciliation_checks.cluster = excluded.cluster
    and public.escrow_reconciliation_checks.program_id = excluded.program_id;

  insert into public.escrow_reconciliation_state (
    market_id, checked_slot, cluster, program_id, vault_balance_atomic,
    liability_atomic, drift_atomic, position_account_count, status, checked_at
  ) values (
    p_market_id, p_checked_slot, p_cluster, p_program_id, p_vault_balance_atomic,
    p_liability_atomic, v_drift, p_position_account_count, p_status, p_checked_at
  ) on conflict (market_id) do update
  set checked_slot = excluded.checked_slot,
      cluster = excluded.cluster,
      program_id = excluded.program_id,
      vault_balance_atomic = excluded.vault_balance_atomic,
      liability_atomic = excluded.liability_atomic,
      drift_atomic = excluded.drift_atomic,
      position_account_count = excluded.position_account_count,
      status = excluded.status,
      checked_at = excluded.checked_at
  where excluded.checked_slot >= public.escrow_reconciliation_state.checked_slot;

  update public.escrow_market_links links
  set projection_stale = p_status <> 'in_sync',
      updated_at = greatest(links.updated_at, p_checked_at)
  from public.escrow_reconciliation_state current_check
  where links.market_id = p_market_id
    and current_check.market_id = links.market_id
    and current_check.cluster = p_cluster
    and current_check.program_id = p_program_id
    and current_check.checked_slot = p_checked_slot;

  update public.escrow_market_links links
  set chain_state = v_chain_state,
      event_epoch = v_event_epoch
  from public.escrow_reconciliation_state current_check
  where links.market_id = p_market_id
    and current_check.market_id = links.market_id
    and current_check.cluster = p_cluster
    and current_check.program_id = p_program_id
    and current_check.checked_slot = p_checked_slot
    and v_chain_state is not null;

  return jsonb_build_object(
    'ok', true,
    'duplicate', v_duplicate,
    'finalized', true
  );
end;
$$;

-- Repair links from the exact check referenced by the latest accepted state.
-- Invalid or incomplete legacy detail payloads are intentionally ignored.
update public.escrow_market_links links
set chain_state = checks.details ->> 'chainState',
    event_epoch = (checks.details ->> 'eventEpoch')::numeric(20, 0),
    projection_stale = current_state.status <> 'in_sync',
    updated_at = greatest(links.updated_at, checks.checked_at)
from public.escrow_reconciliation_state current_state
join public.escrow_reconciliation_checks checks
  on current_state.market_id = checks.market_id
 and current_state.checked_slot = checks.checked_slot
 and current_state.cluster = checks.cluster
 and current_state.program_id = checks.program_id
where links.market_id = current_state.market_id
  and links.cluster = current_state.cluster
  and links.program_id = current_state.program_id
  and (
    links.chain_state not in ('settled', 'voided', 'closed')
    or checks.details ->> 'chainState' in ('settled', 'voided', 'closed')
  )
  and checks.details ->> 'chainState' in ('open', 'frozen', 'settled', 'voided', 'closed')
  and checks.details ->> 'eventEpoch' ~ '^(0|[1-9][0-9]*)$';
