-- Completed-match tests use the real position and settlement model without
-- consuming a user's once-only starter grant or writing wager ledger entries.
-- This RPC is service-role only and accepts replay-marked markets exclusively.
create or replace function public.place_replay_position(
  p_user_id bigint,
  p_group_id bigint,
  p_market_id uuid,
  p_side text,
  p_stake bigint,
  p_multiplier double precision,
  p_state text,
  p_placed_at_ms bigint
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_market public.markets%rowtype;
  v_position_id uuid;
begin
  if p_side not in ('back', 'doubt') then
    return jsonb_build_object('ok', false, 'code', 'wrong_side');
  end if;
  if p_stake <> 10000000 or p_state not in ('pending', 'active') then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;
  if p_user_id is null or p_group_id is null or p_market_id is null or p_placed_at_ms is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('replay-position:' || p_market_id::text || ':' || p_user_id::text, 0)
  );

  select * into v_market
  from public.markets
  where id = p_market_id
  for update;

  if v_market.id is null
     or v_market.group_id <> p_group_id
     or not v_market.is_replay
     or v_market.currency <> 'sol' then
    return jsonb_build_object('ok', false, 'code', 'not_replay');
  end if;
  if v_market.status not in ('pending_lineup', 'open') then
    return jsonb_build_object('ok', false, 'code', 'closed');
  end if;

  if exists (
    select 1 from public.positions
    where market_id = p_market_id and user_id = p_user_id
  ) then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;

  insert into public.positions (
    market_id,
    user_id,
    side,
    stake,
    locked_multiplier,
    locked_odds_message_id,
    locked_odds_ts,
    state,
    placed_at_ms
  ) values (
    p_market_id,
    p_user_id,
    p_side,
    p_stake,
    p_multiplier,
    v_market.odds_message_id,
    v_market.odds_ts,
    p_state,
    p_placed_at_ms
  ) returning id into v_position_id;

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'position_id', v_position_id
  );
end;
$$;

revoke all on function public.place_replay_position(
  bigint, bigint, uuid, text, bigint, double precision, text, bigint
) from public, anon, authenticated;

grant execute on function public.place_replay_position(
  bigint, bigint, uuid, text, bigint, double precision, text, bigint
) to service_role;
