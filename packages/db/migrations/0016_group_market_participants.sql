-- Active cards need a bounded identity projection, but physical positions are
-- financial records and may contain repeated placements by the same person.
create function group_market_participants(p_market_id uuid)
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
      m.group_id,
      p.market_id,
      p.user_id,
      p.side,
      min(p.placed_at_ms) as first_placed_at_ms
    from public.positions p
    join public.markets m on m.id = p.market_id
    where p.market_id = p_market_id
      and p.state in ('pending', 'active')
    group by m.group_id, p.market_id, p.user_id, p.side
  ), ranked_participants as (
    select
      d.group_id,
      d.market_id,
      d.user_id,
      d.side,
      d.first_placed_at_ms,
      count(*) over (partition by d.market_id, d.side)::int as participant_count,
      row_number() over (
        partition by d.market_id, d.side
        order by d.first_placed_at_ms, d.user_id
      ) as side_rank
    from distinct_participants d
  )
  select
    r.group_id,
    r.market_id,
    r.user_id,
    r.side,
    r.first_placed_at_ms,
    u.display_name,
    u.username,
    r.participant_count
  from ranked_participants r
  join public.users u on u.id = r.user_id
  where r.side_rank <= 5
  order by r.first_placed_at_ms, r.user_id, r.side
$$;

revoke execute on function group_market_participants(uuid) from public, anon, authenticated;
grant execute on function group_market_participants(uuid) to service_role;
