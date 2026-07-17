-- A public cluster is shared by multiple Called It deployments. Its program
-- stream therefore contains valid markets that are intentionally absent from
-- this database. Ignore those market roots; their child events are filtered
-- by the engine projector until a tracked market link exists.

alter function public.escrow_index_market_link(
  uuid, text, integer, text, text, text, text, text, text, text, text,
  text, integer, bigint, timestamptz, numeric, numeric, numeric, text, timestamptz
) rename to escrow_index_tracked_market_link;

create function public.escrow_index_market_link(
  p_market_id uuid,
  p_custody_mode text,
  p_custody_version integer,
  p_cluster text,
  p_genesis_hash text,
  p_program_id text,
  p_market_pda text,
  p_vault_pda text,
  p_asset text,
  p_mint_pubkey text,
  p_document_hash_hex text,
  p_initialize_signature text,
  p_initialize_instruction_index integer,
  p_initialize_slot bigint,
  p_initialize_block_time timestamptz,
  p_oracle_epoch numeric,
  p_event_epoch numeric,
  p_ratio_milli numeric,
  p_commitment text,
  p_observed_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.markets where id = p_market_id) then
    return jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'finalized', p_commitment = 'finalized'
    );
  end if;

  return public.escrow_index_tracked_market_link(
    p_market_id, p_custody_mode, p_custody_version, p_cluster,
    p_genesis_hash, p_program_id, p_market_pda, p_vault_pda, p_asset,
    p_mint_pubkey, p_document_hash_hex, p_initialize_signature,
    p_initialize_instruction_index, p_initialize_slot,
    p_initialize_block_time, p_oracle_epoch, p_event_epoch,
    p_ratio_milli, p_commitment, p_observed_at
  );
end;
$$;

revoke execute on function public.escrow_index_tracked_market_link(
  uuid, text, integer, text, text, text, text, text, text, text, text,
  text, integer, bigint, timestamptz, numeric, numeric, numeric, text, timestamptz
) from public, anon, authenticated, service_role;
revoke execute on function public.escrow_index_market_link(
  uuid, text, integer, text, text, text, text, text, text, text, text,
  text, integer, bigint, timestamptz, numeric, numeric, numeric, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.escrow_index_market_link(
  uuid, text, integer, text, text, text, text, text, text, text, text,
  text, integer, bigint, timestamptz, numeric, numeric, numeric, text, timestamptz
) to service_role;

