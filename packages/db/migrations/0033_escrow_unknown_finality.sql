-- A durable signed transaction cannot be abandoned merely because its polling
-- budget elapsed. Once bytes and the expected signature are persisted, the
-- relayer must keep observing the same transaction until chain state is
-- terminal. The configured attempt bound still limits unsigned work and the
-- counter itself remains bounded for operational reporting.
create or replace function public.escrow_relayer_lease(
  p_worker_id text,
  p_now timestamptz,
  p_limit integer
) returns setof public.escrow_relayer_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_worker_id is null or p_worker_id = '' or p_limit < 1 or p_limit > 100 then
    raise exception 'escrow_relayer_lease_input_invalid';
  end if;

  return query
  with candidates as (
    select jobs.id
    from public.escrow_relayer_jobs jobs
    where (
        jobs.attempts < jobs.max_attempts
        or (
          jobs.raw_transaction is not null
          and jobs.expected_signature is not null
          and (
            jobs.state in ('signed', 'submitted', 'unknown')
            or (jobs.state = 'leased' and jobs.lease_expires_at <= p_now)
          )
        )
      )
      and (
        (jobs.state in ('pending', 'retry_wait', 'signed', 'submitted', 'unknown') and jobs.due_at <= p_now)
        or (jobs.state = 'leased' and jobs.lease_expires_at <= p_now)
      )
    order by jobs.due_at, jobs.created_at, jobs.id
    for update skip locked
    limit p_limit
  )
  update public.escrow_relayer_jobs jobs
  set state = 'leased',
      attempts = case
        when jobs.raw_transaction is not null and jobs.expected_signature is not null
          then least(jobs.attempts + 1, jobs.max_attempts)
        else jobs.attempts + 1
      end,
      lease_owner = p_worker_id,
      lease_token = gen_random_uuid(),
      leased_at = p_now,
      lease_expires_at = p_now + make_interval(secs => jobs.lease_duration_ms / 1000.0),
      updated_at = p_now
  from candidates
  where jobs.id = candidates.id
  returning jobs.*;
end;
$$;

-- Keyset cursors identify the last row returned, not the first row withheld.
-- Returning the p_limit+1 boundary while the next query uses `market_id >`
-- permanently skipped one market per page (every market when p_limit = 1).
create or replace function public.escrow_list_reconciliation_links(
  p_cluster text,
  p_genesis_hash text,
  p_program_id text,
  p_custody_version integer,
  p_cursor uuid,
  p_limit integer
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
  v_next_cursor uuid;
begin
  if p_cluster not in ('localnet', 'devnet', 'mainnet-beta')
     or p_genesis_hash is null or length(p_genesis_hash) not between 1 and 128
     or p_program_id is null or length(p_program_id) not between 1 and 128
     or p_custody_version is null or p_custody_version <= 0
     or p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'escrow_reconciliation_link_query_invalid';
  end if;

  with candidates as (
    select
      ml.market_id,
      ml.custody_mode,
      ml.market_pda,
      ml.vault_pda,
      ml.asset,
      ml.projection_stale
    from public.escrow_market_links ml
    join public.markets market on market.id = ml.market_id
    where ml.cluster = p_cluster
      and ml.genesis_hash = p_genesis_hash
      and ml.program_id = p_program_id
      and ml.custody_mode = 'escrow'
      and market.custody_mode = 'escrow'
      and ml.custody_version = p_custody_version
      and ml.commitment = 'finalized'
      and ml.canonical
      and ml.chain_state <> 'closed'
      and (p_cursor is null or ml.market_id > p_cursor)
    order by ml.market_id
    limit p_limit + 1
  ), page as (
    select * from candidates order by market_id limit p_limit
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'market_id', page.market_id,
      'custody_mode', page.custody_mode,
      'market_pda', page.market_pda,
      'vault_pda', page.vault_pda,
      'asset', page.asset,
      'revalidation_required', page.projection_stale
    ) order by page.market_id), '[]'::jsonb),
    case
      when (select count(*) from candidates) > p_limit
        then (select market_id from page order by market_id desc limit 1)
      else null
    end
  into v_rows, v_next_cursor
  from page;

  return jsonb_build_object('links', v_rows, 'next_cursor', v_next_cursor);
end;
$$;
