-- Group cards and points must agree about who participated. Legacy markets
-- retain their Telegram-owned positions; devnet escrow markets resolve an
-- owner pubkey only through the immutable consumed signing session that
-- authorized that exact finalized placement. Missing identity is deliberately
-- omitted instead of guessed, and a later wallet relink cannot rewrite history.
create view public.group_market_participant_source
with (security_invoker = true)
as
select
  market.group_id,
  position.market_id,
  position.user_id,
  position.side,
  position.placed_at_ms as first_placed_at_ms,
  position.state as participant_state
from public.positions position
join public.markets market on market.id = position.market_id
where market.custody_mode = 'legacy'
  and position.state in ('pending', 'active')

union all

select
  market.group_id,
  lot.market_id,
  signing.user_id,
  lot.side,
  floor(extract(epoch from coalesce(placed.block_time, placed.observed_at)) * 1000)::bigint
    as first_placed_at_ms,
  lot.state as participant_state
from public.escrow_position_lots lot
join public.escrow_position_accounts account
  on account.market_id = lot.market_id
 and account.owner_pubkey = lot.owner_pubkey
 and account.position_pda = lot.position_pda
 and account.side = lot.side
 and account.asset = lot.asset
join public.escrow_position_events placed
  on placed.signature = lot.placed_signature
 and placed.instruction_index = lot.placed_instruction_index
 and placed.market_id = lot.market_id
 and placed.owner_pubkey = lot.owner_pubkey
 and placed.lot_nonce = lot.lot_nonce
 and placed.event_kind = 'placed'
join public.escrow_market_links link
  on link.market_id = lot.market_id
 and link.cluster = 'devnet'
 and link.commitment = 'finalized'
 and link.canonical
 and not link.projection_stale
join public.markets market
  on market.id = lot.market_id
 and market.custody_mode = 'escrow'
join public.escrow_signing_sessions signing
  on signing.state = 'consumed'
 and signing.transaction_signature = placed.signature
 and signing.market_id = lot.market_id
 and signing.owner_pubkey = lot.owner_pubkey
 and signing.lot_nonce = lot.lot_nonce
 and signing.side = lot.side
 and signing.asset = lot.asset
 and signing.amount_atomic = lot.amount_atomic
 and signing.event_epoch = lot.event_epoch
where lot.commitment = 'finalized'
  and lot.canonical
  and account.commitment = 'finalized'
  and account.canonical
  and account.deposited_atomic > 0
  and placed.commitment = 'finalized'
  and placed.canonical
  and signing.consumed_at is not null
  and lot.state in ('pending', 'active', 'refundable', 'claimed');

-- This projection is derived exclusively from the append-only score events.
-- group_player_stats remains maintained below only as a rolling-deploy fallback.
create view public.group_player_stats_from_events
with (security_invoker = true)
as
with ordered_events as (
  select
    event.group_id,
    event.user_id,
    event.market_id,
    event.result,
    event.points_delta,
    event.settled_at,
    count(*) filter (where event.result = 'lost') over (
      partition by event.group_id, event.user_id
      order by event.settled_at, event.market_id
      rows between unbounded preceding and current row
    ) as loss_group
  from public.group_point_events event
), totals as (
  select
    ordered.group_id,
    ordered.user_id,
    sum(ordered.points_delta)::bigint as points,
    count(*) filter (where ordered.result = 'won')::bigint as wins,
    count(*) filter (where ordered.result = 'lost')::bigint as losses,
    max(ordered.settled_at) as updated_at
  from ordered_events ordered
  group by ordered.group_id, ordered.user_id
), streaks as (
  select
    ordered.group_id,
    ordered.user_id,
    ordered.loss_group,
    count(*) filter (where ordered.result = 'won')::bigint as streak
  from ordered_events ordered
  group by ordered.group_id, ordered.user_id, ordered.loss_group
), streak_totals as (
  select
    streak.group_id,
    streak.user_id,
    (array_agg(streak.streak order by streak.loss_group desc))[1]::bigint as current_streak,
    max(streak.streak)::bigint as best_streak
  from streaks streak
  group by streak.group_id, streak.user_id
)
select
  total.group_id,
  total.user_id,
  total.points,
  total.wins,
  total.losses,
  streak.current_streak,
  streak.best_streak,
  total.updated_at,
  jsonb_build_object(
    'display_name', app_user.display_name,
    'username', app_user.username
  ) as "user"
from totals total
join streak_totals streak
  on streak.group_id = total.group_id
 and streak.user_id = total.user_id
join public.users app_user on app_user.id = total.user_id;

revoke all privileges on table
  public.group_market_participant_source,
  public.group_player_stats_from_events
from public, anon, authenticated, service_role;
grant select on table
  public.group_market_participant_source,
  public.group_player_stats_from_events
to service_role;

-- Preserve the existing RPC shape while sourcing both custody modes from the
-- single verified participant projection.
create or replace function public.group_market_participants(p_market_id uuid)
returns table (
  group_id bigint,
  market_id uuid,
  user_id bigint,
  side text,
  first_placed_at_ms bigint,
  display_name text,
  username text,
  participant_count int
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with distinct_participants as (
    select
      source.group_id,
      source.market_id,
      source.user_id,
      source.side,
      min(source.first_placed_at_ms) as first_placed_at_ms
    from public.group_market_participant_source source
    where source.market_id = p_market_id
      and source.participant_state in ('pending', 'active', 'refundable', 'claimed')
    group by source.group_id, source.market_id, source.user_id, source.side
  ), ranked_participants as (
    select
      participant.group_id,
      participant.market_id,
      participant.user_id,
      participant.side,
      participant.first_placed_at_ms,
      count(*) over (partition by participant.market_id, participant.side)::int
        as participant_count,
      row_number() over (
        partition by participant.market_id, participant.side
        order by participant.first_placed_at_ms, participant.user_id
      ) as side_rank
    from distinct_participants participant
  )
  select
    ranked.group_id,
    ranked.market_id,
    ranked.user_id,
    ranked.side,
    ranked.first_placed_at_ms,
    app_user.display_name,
    app_user.username,
    ranked.participant_count
  from ranked_participants ranked
  join public.users app_user on app_user.id = ranked.user_id
  where ranked.side_rank <= 5
  order by ranked.first_placed_at_ms, ranked.user_id, ranked.side
$$;

revoke execute on function public.group_market_participants(uuid)
from public, anon, authenticated;
grant execute on function public.group_market_participants(uuid) to service_role;

-- Repair the narrow historical gap created when escrow markets were marked as
-- points-applied before escrow participants were a scoring source. Only
-- already-applied, non-replay, chain-proven SOL settlements with zero existing
-- score events are eligible. Conflicting two-sided identity fails closed.
with repairable_markets as (
  select
    market.id as market_id,
    market.group_id,
    settlement.outcome,
    settlement.settled_at
  from public.markets market
  join public.groups app_group on app_group.id = market.group_id
  join public.settlements settlement on settlement.market_id = market.id
  join public.group_points_applied applied on applied.market_id = market.id
  where market.custody_mode = 'escrow'
    and not market.is_replay
    and market.currency = 'sol'
    and market.status = 'settled'
    and settlement.outcome in ('claim_won', 'claim_lost')
    and settlement.tier = 'chain_proven'
    and settlement.settled_at >= app_group.points_started_at
    and not exists (
      select 1 from public.group_point_events existing
      where existing.market_id = market.id
    )
    and not exists (
      select 1
      from public.group_market_participant_source conflicting
      where conflicting.market_id = market.id
        and conflicting.participant_state in ('active', 'refundable', 'claimed')
      group by conflicting.user_id
      having count(distinct conflicting.side) > 1
    )
), repair_participants as (
  select distinct
    repair.group_id,
    repair.market_id,
    source.user_id,
    source.side,
    repair.outcome,
    repair.settled_at
  from repairable_markets repair
  join public.group_market_participant_source source
    on source.market_id = repair.market_id
   and source.participant_state in ('active', 'refundable', 'claimed')
)
insert into public.group_point_events (
  group_id, market_id, user_id, side, result, points_delta, settled_at
)
select
  participant.group_id,
  participant.market_id,
  participant.user_id,
  participant.side,
  case
    when (participant.outcome = 'claim_won' and participant.side = 'back')
      or (participant.outcome = 'claim_lost' and participant.side = 'doubt')
    then 'won'
    else 'lost'
  end,
  case
    when (participant.outcome = 'claim_won' and participant.side = 'back')
      or (participant.outcome = 'claim_lost' and participant.side = 'doubt')
    then 10
    else 0
  end,
  participant.settled_at
from repair_participants participant
on conflict (market_id, user_id) do nothing;

-- group_player_stats is a compatibility cache. Rebuild it deterministically
-- after the repair so old engine builds observe the same event truth.
delete from public.group_player_stats;
insert into public.group_player_stats (
  group_id, user_id, points, wins, losses, current_streak, best_streak, updated_at
)
select
  stats.group_id,
  stats.user_id,
  stats.points,
  stats.wins,
  stats.losses,
  stats.current_streak,
  stats.best_streak,
  stats.updated_at
from public.group_player_stats_from_events stats;

-- The scoring RPC keeps its replay and activation gates intact, but reads the
-- same custody-aware participant truth as live cards. The cached table is
-- refreshed from the event-derived view for old engine builds during rollout.
create or replace function public.group_points_apply(p_market_id uuid) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_currency text;
  v_group_id bigint;
  v_is_replay boolean;
  v_market_status text;
  v_outcome text;
  v_points_started_at timestamptz;
  v_scored_count int;
  v_settled_at timestamptz;
  v_winning_side text;
  v_winner_count int;
begin
  select market.currency, market.group_id, market.is_replay, market.status, app_group.points_started_at
  into v_currency, v_group_id, v_is_replay, v_market_status, v_points_started_at
  from public.markets market
  join public.groups app_group on app_group.id = market.group_id
  where market.id = p_market_id;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'market_not_found');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('calledit:group-points:group:' || v_group_id::text, 0)
  );

  select settlement.outcome, settlement.settled_at
  into v_outcome, v_settled_at
  from public.settlements settlement
  where settlement.market_id = p_market_id;

  if not found or v_market_status not in ('settled', 'voided') then
    return jsonb_build_object('ok', false, 'code', 'settlement_missing');
  end if;

  if exists (
    select 1 from public.group_points_applied applied where applied.market_id = p_market_id
  ) then
    select
      count(*)::int,
      count(*) filter (where event.result = 'won')::int
    into v_scored_count, v_winner_count
    from public.group_point_events event
    where event.market_id = p_market_id;

    return jsonb_build_object(
      'ok', true,
      'eligible', true,
      'duplicate', true,
      'reason', null,
      'group_id', v_group_id,
      'scored_count', v_scored_count,
      'winner_count', v_winner_count
    );
  end if;

  if v_settled_at < v_points_started_at then
    return jsonb_build_object(
      'ok', true, 'eligible', false, 'duplicate', false,
      'reason', 'pre_activation', 'group_id', v_group_id,
      'scored_count', 0, 'winner_count', 0
    );
  end if;

  if v_is_replay then
    return jsonb_build_object(
      'ok', true, 'eligible', false, 'duplicate', false,
      'reason', 'replay', 'group_id', v_group_id,
      'scored_count', 0, 'winner_count', 0
    );
  end if;

  if v_currency <> 'sol' then
    return jsonb_build_object(
      'ok', true, 'eligible', false, 'duplicate', false,
      'reason', 'unsupported_market', 'group_id', v_group_id,
      'scored_count', 0, 'winner_count', 0
    );
  end if;

  v_scored_count := 0;
  v_winner_count := 0;

  if exists (
    select 1
    from public.group_market_participant_source source
    where source.market_id = p_market_id
      and source.participant_state in ('active', 'refundable', 'claimed')
    group by source.user_id
    having count(distinct source.side) > 1
  ) then
    return jsonb_build_object('ok', false, 'code', 'position_conflict');
  end if;

  if v_outcome <> 'void' then
    v_winning_side := case v_outcome
      when 'claim_won' then 'back'
      when 'claim_lost' then 'doubt'
    end;

    insert into public.group_point_events (
      group_id, market_id, user_id, side, result, points_delta, settled_at
    )
    select
      v_group_id,
      p_market_id,
      participant.user_id,
      participant.side,
      case when participant.side = v_winning_side then 'won' else 'lost' end,
      case when participant.side = v_winning_side then 10 else 0 end,
      v_settled_at
    from (
      select distinct source.user_id, source.side
      from public.group_market_participant_source source
      where source.market_id = p_market_id
        and source.participant_state in ('active', 'refundable', 'claimed')
    ) participant;

    get diagnostics v_scored_count = row_count;

    select count(*) filter (where event.result = 'won')::int
    into v_winner_count
    from public.group_point_events event
    where event.market_id = p_market_id;

    insert into public.group_player_stats (
      group_id, user_id, points, wins, losses, current_streak, best_streak, updated_at
    )
    select
      stats.group_id,
      stats.user_id,
      stats.points,
      stats.wins,
      stats.losses,
      stats.current_streak,
      stats.best_streak,
      stats.updated_at
    from public.group_player_stats_from_events stats
    where stats.group_id = v_group_id
      and exists (
        select 1
        from public.group_point_events event
        where event.market_id = p_market_id
          and event.user_id = stats.user_id
      )
    on conflict (group_id, user_id) do update
    set points = excluded.points,
        wins = excluded.wins,
        losses = excluded.losses,
        current_streak = excluded.current_streak,
        best_streak = excluded.best_streak,
        updated_at = excluded.updated_at;
  end if;

  insert into public.group_points_applied (market_id, group_id, settled_at)
  values (p_market_id, v_group_id, v_settled_at);

  return jsonb_build_object(
    'ok', true,
    'eligible', true,
    'duplicate', false,
    'reason', null,
    'group_id', v_group_id,
    'scored_count', v_scored_count,
    'winner_count', v_winner_count
  );
end;
$$;

revoke execute on function public.group_points_apply(uuid)
from public, anon, authenticated;
grant execute on function public.group_points_apply(uuid) to service_role;
