-- A user signature is durable only together with its relayer outbox entry.
-- This RPC holds the signing session row until the idempotent placement job
-- has been persisted, so a failed enqueue rolls the consumption back.
create function public.escrow_consume_signing_session_and_enqueue_placement(
  p_token_hash_hex text,
  p_user_id bigint,
  p_provider_user_id text,
  p_provider_wallet_id text,
  p_owner_pubkey text,
  p_market_id uuid,
  p_transaction_message_hash_hex text,
  p_transaction_signature text,
  p_idempotency_key text,
  p_cluster text,
  p_program_id text,
  p_custody_mode text,
  p_custody_version integer,
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
  v_token_hash bytea := public.escrow_decode_sha256_hex(p_token_hash_hex);
  v_session public.escrow_signing_sessions%rowtype;
  v_enqueue jsonb;
  v_session_duplicate boolean := false;
begin
  if v_token_hash is null
     or p_now is null
     or p_transaction_signature is null or p_transaction_signature = ''
     or p_idempotency_key is null or p_idempotency_key = ''
     or p_cluster not in ('localnet', 'devnet', 'mainnet-beta')
     or p_program_id is null or p_program_id = ''
     or p_custody_mode <> 'escrow'
     or p_custody_version is null or p_custody_version <= 0
     or p_due_at is null
     or p_max_attempts is null or p_max_attempts <= 0
     or p_lease_ms is null or p_lease_ms < 1000 or p_lease_ms > 600000
     or jsonb_typeof(p_payload) <> 'object' then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;

  select * into v_session
  from public.escrow_signing_sessions
  where token_hash = v_token_hash
  for update;
  if v_session.token_hash is null then
    return jsonb_build_object('ok', false, 'code', 'session_not_found');
  end if;

  if v_session.user_id is distinct from p_user_id
     or v_session.provider_user_id is distinct from p_provider_user_id
     or v_session.provider_wallet_id is distinct from p_provider_wallet_id
     or v_session.owner_pubkey is distinct from p_owner_pubkey
     or v_session.market_id is distinct from p_market_id
     or lower(v_session.transaction_message_hash_hex) is distinct from lower(p_transaction_message_hash_hex) then
    return jsonb_build_object('ok', false, 'code', 'binding_mismatch');
  end if;

  -- The signed wire bytes differ from the pre-signing presentation, so bind
  -- the durable job to the session's immutable message and authorization terms.
  if p_payload ->> 'operation' is distinct from 'place_position'
     or p_payload ->> 'expectedSignature' is distinct from p_transaction_signature
     or lower(p_payload ->> 'transactionMessageHashHex') is distinct from lower(v_session.transaction_message_hash_hex)
     or p_payload ->> 'marketId' is distinct from v_session.market_id::text
     or p_payload ->> 'ownerPubkey' is distinct from v_session.owner_pubkey
     or p_payload ->> 'programId' is distinct from p_program_id
     or p_payload ->> 'programId' is distinct from v_session.authorization_payload ->> 'programId'
     or p_payload ->> 'marketPda' is distinct from v_session.authorization_payload ->> 'marketPda'
     or lower(p_payload ->> 'marketDocumentHashHex') is distinct from lower(v_session.document_hash_hex)
     or p_payload ->> 'feePayer' is distinct from v_session.authorization_payload ->> 'relayerFeePayer'
     or p_payload ->> 'canonicalUsdcMint' is distinct from v_session.authorization_payload ->> 'canonicalUsdcMint'
     or p_payload ->> 'genesisHash' is distinct from v_session.authorization_payload ->> 'genesisHash'
     or p_payload ->> 'recentBlockhash' is distinct from v_session.authorization_payload ->> 'recentBlockhash'
     or p_payload ->> 'lastValidBlockHeight' is distinct from v_session.authorization_payload ->> 'lastValidBlockHeight'
     or p_payload ->> 'side' is distinct from v_session.side
     or p_payload ->> 'asset' is distinct from v_session.asset
     or p_payload ->> 'amountAtomic' is distinct from v_session.amount_atomic::text
     or p_payload ->> 'lotNonce' is distinct from v_session.lot_nonce::text
     or p_payload ->> 'eventEpoch' is distinct from v_session.event_epoch::text
     or p_payload ->> 'expiresAt' is distinct from v_session.authorization_payload ->> 'expiresAt'
     or p_payload ->> 'rawTransactionBase64' is null
     or length(p_payload ->> 'rawTransactionBase64') not between 4 and 4096
     or length(p_payload ->> 'rawTransactionBase64') % 4 <> 0
     or p_payload ->> 'rawTransactionBase64' !~ '^[A-Za-z0-9+/]+={0,2}$' then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;

  if v_session.state = 'consumed' then
    if v_session.transaction_signature is distinct from p_transaction_signature then
      return jsonb_build_object('ok', false, 'code', 'session_consumed');
    end if;
    v_session_duplicate := true;
  elsif v_session.state <> 'pending' then
    return jsonb_build_object('ok', false, 'code', 'session_consumed');
  elsif v_session.expires_at <= p_now then
    update public.escrow_signing_sessions
    set state = 'expired', updated_at = p_now
    where token_hash = v_token_hash;
    return jsonb_build_object('ok', false, 'code', 'session_expired');
  else
    update public.escrow_signing_sessions
    set state = 'consumed',
        transaction_signature = p_transaction_signature,
        consumed_at = p_now,
        updated_at = p_now
    where token_hash = v_token_hash;
  end if;

  v_enqueue := public.escrow_relayer_enqueue(
    'position_placement', p_idempotency_key, p_cluster, p_program_id,
    p_custody_mode, p_custody_version, v_session.market_id, v_session.owner_pubkey,
    p_payload, p_due_at, p_max_attempts, p_lease_ms, p_now
  );
  if v_enqueue ->> 'ok' is distinct from 'true'
     or v_enqueue ->> 'job_id' is null
     or v_enqueue ->> 'created' is null then
    raise exception 'escrow_atomic_placement_enqueue_invalid';
  end if;

  return jsonb_build_object(
    'ok', true,
    'duplicate', v_session_duplicate,
    'state', 'consumed',
    'job_created', (v_enqueue ->> 'created')::boolean,
    'job_id', v_enqueue ->> 'job_id'
  );
end;
$$;

-- Finalized links with a stale projection remain quarantined from normal
-- workflows, but must stay visible to the reconciler so a finalized snapshot
-- can either clear the quarantine or keep reporting the drift.
create index escrow_market_links_reconciliation_scan_idx
  on public.escrow_market_links (
    cluster, genesis_hash, program_id, custody_version, market_id
  )
  where custody_mode = 'escrow'
    and commitment = 'finalized'
    and canonical
    and chain_state <> 'closed';

create function public.escrow_list_reconciliation_links(
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
    (select market_id from candidates order by market_id offset p_limit limit 1)
  into v_rows, v_next_cursor
  from page;

  return jsonb_build_object('links', v_rows, 'next_cursor', v_next_cursor);
end;
$$;

revoke execute on function public.escrow_consume_signing_session_and_enqueue_placement(
  text, bigint, text, text, text, uuid, text, text, text, text, text, text,
  integer, jsonb, timestamptz, integer, integer, timestamptz
) from public, anon, authenticated;
grant execute on function public.escrow_consume_signing_session_and_enqueue_placement(
  text, bigint, text, text, text, uuid, text, text, text, text, text, text,
  integer, jsonb, timestamptz, integer, integer, timestamptz
) to service_role;

revoke execute on function public.escrow_list_reconciliation_links(
  text, text, text, integer, uuid, integer
) from public, anon, authenticated;
grant execute on function public.escrow_list_reconciliation_links(
  text, text, text, integer, uuid, integer
) to service_role;
