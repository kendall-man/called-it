-- Called It -- durable bot-install readiness marker.
--
-- Telegram group lifecycle updates may be retried or delivered concurrently.
-- The only actor allowed to decide whether a group gets its one ready message is
-- this database function; callers receive `created` and never infer it locally.

create table bot_group_ready_markers (
  group_id           bigint not null references groups(id) on delete cascade,
  onboarding_version text not null check (onboarding_version = 'calledit_v1'),
  ready_at           timestamptz not null default now(),
  primary key (group_id, onboarding_version)
);

alter table bot_group_ready_markers enable row level security;
revoke all privileges on table bot_group_ready_markers from public, anon, authenticated, service_role;

create function bot_mark_group_ready(
  p_group_id bigint,
  p_onboarding_version text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_created boolean;
begin
  if p_group_id is null or p_onboarding_version is distinct from 'calledit_v1' then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;

  perform 1
  from groups
  where id = p_group_id
  for key share;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'group_not_found');
  end if;

  with inserted as (
    insert into bot_group_ready_markers (group_id, onboarding_version)
    values (p_group_id, p_onboarding_version)
    on conflict (group_id, onboarding_version) do nothing
    returning 1
  )
  select exists (select 1 from inserted) into v_created;

  return jsonb_build_object(
    'ok', true,
    'created', v_created,
    'group_id', p_group_id,
    'onboarding_version', p_onboarding_version
  );
end;
$$;

revoke execute on function bot_mark_group_ready(bigint, text) from public, anon, authenticated;
grant execute on function bot_mark_group_ready(bigint, text) to service_role;
