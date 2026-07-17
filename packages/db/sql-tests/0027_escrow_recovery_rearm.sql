begin;

insert into public.groups (id, title, slug, web_enabled)
values (-1000000927001, 'Escrow 0027 test', 'escrow-0027-test', false);

insert into public.users (id, display_name, username)
values (927001, 'PRIVATE_0027_USER', 'private_0027_user');

insert into public.escrow_group_rollouts (
  group_id, custody_mode, cluster, genesis_hash, program_id, custody_version,
  enabled_by, updated_at
) values (
  -1000000927001, 'escrow', 'devnet', 'Genesis927', 'Program927', 2,
  927001, '2026-07-15T09:00:00Z'
);

insert into public.fixtures (
  fixture_id, competition_id, p1_name, p2_name, kickoff_at, phase
) values (
  927001, 1, 'Recovery FC', 'Outage FC', '2026-07-15T09:30:00Z', 'F'
);

insert into public.claims (
  id, group_id, claimer_user_id, tg_message_id, quoted_text, status
) values (
  '92700000-0000-4000-8000-000000000001', -1000000927001, 927001, 1,
  'PRIVATE RECOVERY CLAIM', 'confirmed'
);

insert into public.markets (
  id, claim_id, group_id, fixture_id, spec, status, is_replay,
  price_provenance, quote_probability, quote_multiplier, currency, custody_mode
) values (
  '92700000-0000-4000-8000-000000000101',
  '92700000-0000-4000-8000-000000000001', -1000000927001, 927001,
  '{"claimType":"btts","fixtureId":927001,"entityRef":{"kind":"team","participant":1,"name":"Recovery FC"},"comparator":"eq","threshold":1,"period":"FT_90","trustTier":"chain_proven"}'::jsonb,
  'settled', false, 'market', 0.5, 2, 'sol', 'legacy'
);

insert into public.escrow_chain_event_identities (
  signature, instruction_index, cluster, program_id, event_kind, slot,
  commitment, canonical, observed_at, finalized_at
) values (
  'initialize-927', 0, 'devnet', 'Program927', 'market', 927001,
  'finalized', true, '2026-07-15T09:01:00Z', '2026-07-15T09:01:00Z'
);

insert into public.escrow_market_links (
  market_id, custody_version, cluster, genesis_hash, program_id, market_pda,
  vault_pda, asset, mint_pubkey, document_hash_hex, initialize_signature,
  initialize_instruction_index, initialize_slot, initialize_block_time,
  oracle_epoch, event_epoch, ratio_milli, chain_state, commitment, canonical,
  finalized_at, created_at, updated_at
) values (
  '92700000-0000-4000-8000-000000000101', 2, 'devnet', 'Genesis927',
  'Program927', 'MarketPda927', 'VaultPda927', 'sol', null, repeat('a', 64),
  'initialize-927', 0, 927001, '2026-07-15T09:01:00Z', 1, 1, 1000,
  'settled', 'finalized', true, '2026-07-15T09:01:00Z',
  '2026-07-15T09:01:00Z', '2026-07-15T09:01:00Z'
);

-- An RPC outage consumes the only attempt before any transaction is signed.
select public.escrow_relayer_enqueue(
  'auto_claim', 'recovery-outage-927', 'devnet', 'Program927', 'escrow', 2,
  '92700000-0000-4000-8000-000000000101', 'Owner927',
  '{"schemaVersion":1,"operation":"claim_position_for","owner":"Owner927"}'::jsonb,
  '2026-07-15T10:00:00Z', 1, 60000, '2026-07-15T10:00:00Z'
);

create temp table outage_lease on commit drop as
select * from public.escrow_relayer_lease(
  'outage-worker-927', '2026-07-15T10:00:00Z', 1
);

do $$
declare
  v_job public.escrow_relayer_jobs%rowtype;
  v_result jsonb;
begin
  select * into v_job from outage_lease where idempotency_key = 'recovery-outage-927';
  if v_job.id is null or v_job.attempts <> 1 then
    raise exception 'outage recovery job did not consume its bounded attempt';
  end if;

  v_result := public.escrow_relayer_retry(
    v_job.id, 'outage-worker-927', v_job.lease_token,
    '2026-07-15T10:00:00.100Z', 'rpc_outage', '2026-07-15T10:00:01Z',
    false, null, null
  );
  if v_result ->> 'state' <> 'retry_wait' then
    raise exception 'outage recovery job did not enter exhausted retry wait';
  end if;

  v_result := public.escrow_relayer_enqueue(
    'auto_claim', 'recovery-outage-927', 'devnet', 'Program927', 'escrow', 2,
    '92700000-0000-4000-8000-000000000101', 'Owner927',
    '{"schemaVersion":1,"operation":"claim_position_for","owner":"Owner927"}'::jsonb,
    '2026-07-15T10:01:00Z', 1, 60000, '2026-07-15T10:01:00Z'
  );
  if v_result ->> 'created' <> 'false' or (v_result ->> 'job_id')::uuid <> v_job.id then
    raise exception 'periodic enqueue did not retain the exhausted recovery identity';
  end if;
  if not exists (
    select 1 from public.escrow_relayer_jobs
    where id = v_job.id
      and state = 'pending'
      and attempts = 0
      and max_attempts = 1
      and due_at = '2026-07-15T10:01:00Z'
      and lease_owner is null
      and lease_token is null
      and dead_at is null
      and error_code = 'rearmed_after_exhaustion:rpc_outage'
      and updated_at = '2026-07-15T10:01:00Z'
  ) then
    raise exception 'exhausted recovery job was not audibly rearmed';
  end if;
end;
$$;

create temp table resumed_lease on commit drop as
select * from public.escrow_relayer_lease(
  'resumed-worker-927', '2026-07-15T10:01:00Z', 1
);

do $$
declare
  v_job public.escrow_relayer_jobs%rowtype;
  v_result jsonb;
begin
  select * into v_job from resumed_lease where idempotency_key = 'recovery-outage-927';
  if v_job.id is null or v_job.state <> 'leased' or v_job.attempts <> 1
     or v_job.lease_owner <> 'resumed-worker-927' then
    raise exception 'periodic enqueue did not resume leasing';
  end if;

  v_result := public.escrow_relayer_enqueue(
    'auto_claim', 'recovery-outage-927', 'devnet', 'Program927', 'escrow', 2,
    '92700000-0000-4000-8000-000000000101', 'Owner927',
    '{"schemaVersion":1,"operation":"claim_position_for","owner":"Owner927"}'::jsonb,
    '2026-07-15T10:01:00.500Z', 1, 60000, '2026-07-15T10:01:00.500Z'
  );
  if v_result ->> 'created' <> 'false' or not exists (
    select 1 from public.escrow_relayer_jobs
    where id = v_job.id
      and state = 'leased'
      and attempts = 1
      and lease_token = v_job.lease_token
      and updated_at = '2026-07-15T10:01:00Z'
  ) then
    raise exception 'active recovery duplicate behavior changed';
  end if;
end;
$$;

-- Completed rows remain immutable duplicates.
select public.escrow_relayer_enqueue(
  'account_close', 'recovery-complete-927', 'devnet', 'Program927', 'escrow', 2,
  '92700000-0000-4000-8000-000000000101', null,
  '{"schemaVersion":1,"operation":"close_market"}'::jsonb,
  '2026-07-15T10:02:00Z', 1, 60000, '2026-07-15T10:02:00Z'
);
update public.escrow_relayer_jobs
set state = 'complete', attempts = 1, confirmed_at = '2026-07-15T10:02:10Z',
    completed_at = '2026-07-15T10:02:10Z', updated_at = '2026-07-15T10:02:10Z'
where idempotency_key = 'recovery-complete-927';

do $$
declare
  v_result jsonb;
begin
  v_result := public.escrow_relayer_enqueue(
    'account_close', 'recovery-complete-927', 'devnet', 'Program927', 'escrow', 2,
    '92700000-0000-4000-8000-000000000101', null,
    '{"schemaVersion":1,"operation":"close_market"}'::jsonb,
    '2026-07-15T10:03:00Z', 1, 60000, '2026-07-15T10:03:00Z'
  );
  if v_result ->> 'created' <> 'false' or not exists (
    select 1 from public.escrow_relayer_jobs
    where idempotency_key = 'recovery-complete-927'
      and state = 'complete'
      and completed_at = '2026-07-15T10:02:10Z'
      and updated_at = '2026-07-15T10:02:10Z'
  ) then
    raise exception 'completed recovery duplicate behavior changed';
  end if;
end;
$$;

-- Signed bytes are never cleared or reinterpreted by duplicate enqueue, even
-- without a matching chain observation.
select public.escrow_relayer_enqueue(
  'account_close', 'recovery-signed-927', 'devnet', 'Program927', 'escrow', 2,
  '92700000-0000-4000-8000-000000000101', 'Owner927',
  '{"schemaVersion":1,"operation":"close_position","owner":"Owner927"}'::jsonb,
  '2026-07-15T10:04:00Z', 1, 60000, '2026-07-15T10:04:00Z'
);
update public.escrow_relayer_jobs
set state = 'dead', attempts = 1, raw_transaction = 'signed-bytes-927',
    expected_signature = 'unobserved-signature-927',
    transaction_message_hash_hex = repeat('b', 64), last_valid_block_height = 927100,
    dead_at = '2026-07-15T10:04:10Z', error_code = 'ambiguous_confirmation',
    updated_at = '2026-07-15T10:04:10Z'
where idempotency_key = 'recovery-signed-927';

select public.escrow_relayer_enqueue(
  'account_close', 'recovery-signed-927', 'devnet', 'Program927', 'escrow', 2,
  '92700000-0000-4000-8000-000000000101', 'Owner927',
  '{"schemaVersion":1,"operation":"close_position","owner":"Owner927"}'::jsonb,
  '2026-07-15T10:05:00Z', 1, 60000, '2026-07-15T10:05:00Z'
);

do $$
begin
  if not exists (
    select 1 from public.escrow_relayer_jobs
    where idempotency_key = 'recovery-signed-927'
      and state = 'dead'
      and attempts = 1
      and raw_transaction = 'signed-bytes-927'
      and expected_signature = 'unobserved-signature-927'
      and error_code = 'ambiguous_confirmation'
      and updated_at = '2026-07-15T10:04:10Z'
  ) then
    raise exception 'ambiguous signed transaction bytes were altered';
  end if;
end;
$$;

-- A confirmed chain identity is durable evidence of an economic effect and
-- can never be turned back into pending work.
select public.escrow_relayer_enqueue(
  'settlement_submission', 'recovery-landed-927', 'devnet', 'Program927',
  'escrow', 2, '92700000-0000-4000-8000-000000000101', null,
  '{"schemaVersion":1,"operation":"settle_market","evidenceHash":"927"}'::jsonb,
  '2026-07-15T10:06:00Z', 1, 60000, '2026-07-15T10:06:00Z'
);
update public.escrow_relayer_jobs
set state = 'dead', attempts = 1, raw_transaction = 'landed-bytes-927',
    expected_signature = 'landed-signature-927',
    transaction_message_hash_hex = repeat('c', 64), last_valid_block_height = 927200,
    submitted_at = '2026-07-15T10:06:05Z', confirmed_at = '2026-07-15T10:06:06Z',
    dead_at = '2026-07-15T10:06:10Z', error_code = 'late_observation',
    updated_at = '2026-07-15T10:06:10Z'
where idempotency_key = 'recovery-landed-927';
insert into public.escrow_chain_event_identities (
  signature, instruction_index, cluster, program_id, event_kind, slot,
  commitment, canonical, observed_at, finalized_at
) values (
  'landed-signature-927', 0, 'devnet', 'Program927', 'settlement', 927200,
  'confirmed', true, '2026-07-15T10:06:06Z', null
);

select public.escrow_relayer_enqueue(
  'settlement_submission', 'recovery-landed-927', 'devnet', 'Program927',
  'escrow', 2, '92700000-0000-4000-8000-000000000101', null,
  '{"schemaVersion":1,"operation":"settle_market","evidenceHash":"927"}'::jsonb,
  '2026-07-15T10:07:00Z', 1, 60000, '2026-07-15T10:07:00Z'
);

do $$
begin
  if (select count(*) from public.escrow_chain_event_identities
      where signature = 'landed-signature-927') <> 1
     or not exists (
       select 1 from public.escrow_relayer_jobs
       where idempotency_key = 'recovery-landed-927'
         and state = 'dead'
         and raw_transaction = 'landed-bytes-927'
         and confirmed_at = '2026-07-15T10:06:06Z'
         and updated_at = '2026-07-15T10:06:10Z'
     ) then
    raise exception 'landed economic effect was duplicated or rearmed';
  end if;
end;
$$;

-- Position placement is categorically excluded even when it has no signed
-- transaction evidence.
select public.escrow_relayer_enqueue(
  'position_placement', 'position-placement-dead-927', 'devnet', 'Program927',
  'escrow', 2, '92700000-0000-4000-8000-000000000101', 'Owner927',
  '{"schemaVersion":1,"operation":"place_position"}'::jsonb,
  '2026-07-15T10:08:00Z', 1, 60000, '2026-07-15T10:08:00Z'
);
update public.escrow_relayer_jobs
set state = 'dead', attempts = 1, dead_at = '2026-07-15T10:08:10Z',
    error_code = 'placement_failed', updated_at = '2026-07-15T10:08:10Z'
where idempotency_key = 'position-placement-dead-927';
select public.escrow_relayer_enqueue(
  'position_placement', 'position-placement-dead-927', 'devnet', 'Program927',
  'escrow', 2, '92700000-0000-4000-8000-000000000101', 'Owner927',
  '{"schemaVersion":1,"operation":"place_position"}'::jsonb,
  '2026-07-15T10:09:00Z', 1, 60000, '2026-07-15T10:09:00Z'
);

do $$
begin
  if not exists (
    select 1 from public.escrow_relayer_jobs
    where idempotency_key = 'position-placement-dead-927'
      and state = 'dead'
      and attempts = 1
      and updated_at = '2026-07-15T10:08:10Z'
  ) then
    raise exception 'position placement was rearmed';
  end if;
end;
$$;

-- Idempotency conflicts are rejected before any rearm decision.
do $$
begin
  begin
    perform public.escrow_relayer_enqueue(
      'auto_claim', 'recovery-outage-927', 'devnet', 'Program927', 'escrow', 2,
      '92700000-0000-4000-8000-000000000101', 'DifferentOwner927',
      '{"schemaVersion":1,"operation":"claim_position_for","owner":"Owner927"}'::jsonb,
      '2026-07-15T10:10:00Z', 1, 60000, '2026-07-15T10:10:00Z'
    );
    raise exception 'conflicting recovery binding was accepted';
  exception when others then
    if sqlerrm <> 'escrow_relayer_idempotency_conflict' then raise; end if;
  end;

  begin
    perform public.escrow_relayer_enqueue(
      'auto_claim', 'recovery-outage-927', 'devnet', 'Program927', 'escrow', 2,
      '92700000-0000-4000-8000-000000000101', 'Owner927',
      '{"schemaVersion":1,"operation":"claim_position_for","owner":"OtherOwner927"}'::jsonb,
      '2026-07-15T10:10:00Z', 1, 60000, '2026-07-15T10:10:00Z'
    );
    raise exception 'conflicting recovery payload was accepted';
  exception when others then
    if sqlerrm <> 'escrow_relayer_idempotency_conflict' then raise; end if;
  end;
end;
$$;

rollback;
