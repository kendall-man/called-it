-- Group-scoped points are separate from the retired Rep ledger and membership
-- cache. Existing groups begin at migration time; future groups begin when
-- their row is created.
alter table groups add column points_started_at timestamptz not null default clock_timestamp();

create table group_point_events (
  group_id        bigint not null references groups(id),
  market_id       uuid not null references markets(id),
  user_id         bigint not null references users(id),
  side            text not null check (side in ('back', 'doubt')),
  result          text not null check (result in ('won', 'lost')),
  points_delta    bigint not null check (points_delta in (0, 10)),
  scoring_version int not null default 1 check (scoring_version = 1),
  settled_at      timestamptz not null,
  primary key (market_id, user_id),
  check (
    (result = 'won' and points_delta = 10)
    or (result = 'lost' and points_delta = 0)
  )
);

create table group_player_stats (
  group_id       bigint not null references groups(id),
  user_id        bigint not null references users(id),
  points         bigint not null check (points >= 0),
  wins           bigint not null check (wins >= 0),
  losses         bigint not null check (losses >= 0),
  current_streak bigint not null check (current_streak >= 0),
  best_streak    bigint not null check (best_streak >= current_streak),
  updated_at     timestamptz not null,
  primary key (group_id, user_id)
);

create table group_points_applied (
  market_id       uuid primary key references markets(id),
  group_id        bigint not null references groups(id),
  scoring_version int not null default 1 check (scoring_version = 1),
  settled_at      timestamptz not null,
  applied_at      timestamptz not null default clock_timestamp()
);

create index group_player_stats_leaderboard_idx on group_player_stats (group_id, points desc, wins desc, losses asc, user_id);

create index group_point_events_player_history_idx on group_point_events (group_id, user_id, settled_at, market_id);

alter table group_point_events enable row level security;
alter table group_player_stats enable row level security;
alter table group_points_applied enable row level security;

-- The security-definer function resolves through pg_catalog, public. Keep
-- untrusted roles from creating shadow objects in public on upgraded projects.
revoke create on schema public from public, anon, authenticated, service_role;

-- Repair only these feature-owned objects. Do not alter database-wide default
-- privileges: unrelated future tables may rely on service_role writer grants.
revoke all privileges on table group_point_events, group_player_stats, group_points_applied from public, anon, authenticated, service_role;
grant select on table group_point_events, group_player_stats, group_points_applied to service_role;

create or replace function group_points_apply(p_market_id uuid) returns jsonb
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
  select m.currency, m.group_id, m.is_replay, m.status, g.points_started_at
  into v_currency, v_group_id, v_is_replay, v_market_status, v_points_started_at
  from public.markets m
  join public.groups g on g.id = m.group_id
  where m.id = p_market_id;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'market_not_found');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('calledit:group-points:group:' || v_group_id::text, 0)
  );

  select s.outcome, s.settled_at
  into v_outcome, v_settled_at
  from public.settlements s
  where s.market_id = p_market_id;

  if not found or v_market_status not in ('settled', 'voided') then
    return jsonb_build_object('ok', false, 'code', 'settlement_missing');
  end if;

  if exists (
    select 1 from public.group_points_applied a where a.market_id = p_market_id
  ) then
    select
      count(*)::int,
      count(*) filter (where e.result = 'won')::int
    into v_scored_count, v_winner_count
    from public.group_point_events e
    where e.market_id = p_market_id;

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
      'ok', true,
      'eligible', false,
      'duplicate', false,
      'reason', 'pre_activation',
      'group_id', v_group_id,
      'scored_count', 0,
      'winner_count', 0
    );
  end if;

  if v_is_replay then
    return jsonb_build_object(
      'ok', true,
      'eligible', false,
      'duplicate', false,
      'reason', 'replay',
      'group_id', v_group_id,
      'scored_count', 0,
      'winner_count', 0
    );
  end if;

  if v_currency <> 'sol' then
    return jsonb_build_object(
      'ok', true,
      'eligible', false,
      'duplicate', false,
      'reason', 'unsupported_market',
      'group_id', v_group_id,
      'scored_count', 0,
      'winner_count', 0
    );
  end if;

  v_scored_count := 0;
  v_winner_count := 0;

  if exists (
    select 1
    from public.positions p
    where p.market_id = p_market_id and p.state = 'active'
    group by p.user_id
    having count(distinct p.side) > 1
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
      active_user.user_id,
      active_user.side,
      case when active_user.side = v_winning_side then 'won' else 'lost' end,
      case when active_user.side = v_winning_side then 10 else 0 end,
      v_settled_at
    from (
      select distinct p.user_id, p.side
      from public.positions p
      where p.market_id = p_market_id and p.state = 'active'
    ) active_user;

    get diagnostics v_scored_count = row_count;

    select count(*) filter (where e.result = 'won')::int
    into v_winner_count
    from public.group_point_events e
    where e.market_id = p_market_id;

    with affected_users as (
      select distinct e.user_id
      from public.group_point_events e
      where e.market_id = p_market_id
    ), ordered_events as (
      select
        e.group_id,
        e.user_id,
        e.market_id,
        e.result,
        e.points_delta,
        e.settled_at,
        count(*) filter (where e.result = 'lost') over (
          partition by e.group_id, e.user_id
          order by e.settled_at, e.market_id
          rows between unbounded preceding and current row
        ) as loss_group
      from public.group_point_events e
      join affected_users a on a.user_id = e.user_id
      where e.group_id = v_group_id
    ), totals as (
      select
        o.group_id,
        o.user_id,
        sum(o.points_delta)::bigint as points,
        count(*) filter (where o.result = 'won')::bigint as wins,
        count(*) filter (where o.result = 'lost')::bigint as losses,
        max(o.settled_at) as updated_at
      from ordered_events o
      group by o.group_id, o.user_id
    ), streaks as (
      select
        o.group_id,
        o.user_id,
        o.loss_group,
        count(*) filter (where o.result = 'won')::bigint as streak
      from ordered_events o
      group by o.group_id, o.user_id, o.loss_group
    ), streak_totals as (
      select
        s.group_id,
        s.user_id,
        (array_agg(s.streak order by s.loss_group desc))[1] as current_streak,
        max(s.streak) as best_streak
      from streaks s
      group by s.group_id, s.user_id
    )
    insert into public.group_player_stats (
      group_id, user_id, points, wins, losses, current_streak, best_streak, updated_at
    )
    select
      t.group_id,
      t.user_id,
      t.points,
      t.wins,
      t.losses,
      s.current_streak,
      s.best_streak,
      t.updated_at
    from totals t
    join streak_totals s on s.group_id = t.group_id and s.user_id = t.user_id
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

revoke execute on function group_points_apply(uuid) from public, anon, authenticated;
grant execute on function group_points_apply(uuid) to service_role;
