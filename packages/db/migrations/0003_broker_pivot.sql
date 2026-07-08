-- ── 0003 broker pivot ──────────────────────────────────────────────────────
-- SOL-only peer-matched betting. Two changes:
--   (a) wager_stake v2 — drop the house-liability cap (payouts now come from
--       the opposing pot, so the treasury never over-commits), add a client
--       idempotency key so an at-least-once caller (concierge/API) can never
--       double-stake.
--   (b) public_receipts — expose markets.currency so the web renders SOL.
-- No settlement SQL: peer-matched settlement is app-level (wager/settlement.ts).
-- Rep tables from 0001 and wager_groups from 0002 are left DORMANT (no drops).

-- (a) wager_stake v2 ─────────────────────────────────────────────────────────
-- The argument list changes, so the old overload MUST go or PostgREST rpc()
-- resolution becomes ambiguous.
drop function if exists wager_stake(bigint, bigint, uuid, text, bigint, double precision, text, bigint);

create function wager_stake(
  p_user_id         bigint,
  p_group_id        bigint,
  p_market_id       uuid,
  p_side            text,
  p_lamports        bigint,
  p_multiplier      double precision,
  p_state           text,
  p_placed_at_ms    bigint,
  p_idempotency_key text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  per_market_stake_cap_lamports constant bigint := 100000000;
  v_paused      boolean;
  v_balance     bigint;
  v_wrong_side  int;
  v_user_stakes bigint;
  v_ledger_key  text;
  v_position_id uuid;
begin
  -- Malformed calls are engine bugs, not user outcomes: raise, don't code.
  if p_lamports is null or p_lamports <= 0 then
    raise exception 'wager_stake: lamports must be positive, got %', p_lamports;
  end if;
  if p_side not in ('back', 'doubt') then
    raise exception 'wager_stake: invalid side %', p_side;
  end if;
  if p_state not in ('pending', 'active') then
    raise exception 'wager_stake: invalid state %', p_state;
  end if;

  -- Serialize all money movement for this user (stake vs stake, stake vs
  -- withdrawal, and concurrent replays of the same idempotency key) across
  -- every engine instance.
  perform pg_advisory_xact_lock(hashtextextended('wager:user:' || p_user_id::text, 0));

  -- At-least-once dedup: a prior stake with this client key already landed.
  -- Checked INSIDE the lock so two concurrent replays can't both pass.
  v_ledger_key := case
    when p_idempotency_key is not null then 'wager:stake:api:' || p_idempotency_key
    else null
  end;
  if v_ledger_key is not null
     and exists (select 1 from wager_ledger_entries where idempotency_key = v_ledger_key) then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;

  select coalesce(sum(lamports), 0) into v_balance
  from wager_ledger_entries
  where user_id = p_user_id;
  if v_balance < p_lamports then
    return jsonb_build_object('ok', false, 'code', 'insufficient');
  end if;

  select
    count(*) filter (where user_id = p_user_id and side <> p_side),
    coalesce(sum(stake) filter (where user_id = p_user_id), 0)
  into v_wrong_side, v_user_stakes
  from positions
  where market_id = p_market_id and state <> 'void';

  if v_wrong_side > 0 then
    return jsonb_build_object('ok', false, 'code', 'wrong_side');
  end if;
  if v_user_stakes + p_lamports > per_market_stake_cap_lamports then
    return jsonb_build_object('ok', false, 'code', 'cap');
  end if;

  select paused into v_paused from wager_status where id = 1;
  if v_paused is null then
    raise exception 'wager_stake: wager_status row missing';
  end if;
  if v_paused then
    return jsonb_build_object('ok', false, 'code', 'paused');
  end if;

  -- Positions are shared rows: the reducer's pending window, delay-snipe
  -- voids and activation apply to SOL positions with zero engine changes.
  insert into positions (market_id, user_id, side, stake, locked_multiplier, state, placed_at_ms)
  values (p_market_id, p_user_id, p_side, p_lamports, p_multiplier, p_state, p_placed_at_ms)
  returning id into v_position_id;

  insert into wager_ledger_entries (user_id, group_id, market_id, kind, lamports, idempotency_key)
  values (p_user_id, p_group_id, p_market_id, 'stake', -p_lamports,
          coalesce(v_ledger_key, 'wager:stake:' || v_position_id));

  return jsonb_build_object('ok', true, 'position_id', v_position_id);
end;
$$;

revoke execute on function
  wager_stake(bigint, bigint, uuid, text, bigint, double precision, text, bigint, text)
  from public, anon, authenticated;
grant execute on function
  wager_stake(bigint, bigint, uuid, text, bigint, double precision, text, bigint, text)
  to service_role;

-- (b) public_receipts — append markets.currency ────────────────────────────
-- create or replace can only append columns; restate the 0001 view verbatim
-- with m.currency added last.
create or replace view public_receipts as
select
  m.id as market_id, g.slug as group_slug, g.web_enabled,
  c.quoted_text, u.display_name as claimer_name,
  m.spec, m.status, m.is_replay, m.price_provenance,
  m.quote_probability, m.quote_multiplier, m.created_at,
  s.outcome, s.deciding_seq, s.evidence_seqs, s.tier, s.settled_at,
  p.status as proof_status, p.explorer_url, p.validate_stat_tx,
  p.merkle_proof, p.stat_key, p.seq as proof_seq,
  m.currency
from markets m
join groups g on g.id = m.group_id
join claims c on c.id = m.claim_id
join users u on u.id = c.claimer_user_id
left join settlements s on s.market_id = m.id
left join proofs p on p.market_id = m.id
where g.web_enabled;
