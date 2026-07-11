-- Called It -- public receipts expose aggregate market data only.
--
-- Version 0008 introduced a per-group speaker alias. The allowlisted public
-- devnet beta has a narrower contract: no participant identifier appears in a
-- public receipt, including a stable pseudonym. Recreate the view so existing
-- databases lose the column as well as fresh databases.

drop view public_receipts;

create view public_receipts as
with position_totals as (
  select
    p.market_id,
    coalesce(sum(p.stake) filter (where p.side = 'back'), 0)::bigint as back_pot_lamports,
    coalesce(sum(p.stake) filter (where p.side = 'doubt'), 0)::bigint as doubt_pot_lamports,
    coalesce(sum(p.stake) filter (where p.side = 'back' and p.state = 'active'), 0)::bigint as active_back_lamports,
    coalesce(sum(p.stake) filter (where p.side = 'doubt' and p.state = 'active'), 0)::bigint as active_doubt_lamports,
    count(*)::bigint as position_count
  from positions p
  group by p.market_id
), ledger_totals as (
  select
    l.market_id,
    coalesce(sum(l.lamports) filter (where l.kind = 'refund' and l.lamports > 0), 0)::bigint as refunded_amount_lamports,
    coalesce(sum(l.lamports) filter (where l.kind = 'payout' and l.lamports > 0), 0)::bigint as paid_amount_lamports
  from wager_ledger_entries l
  where l.market_id is not null
  group by l.market_id
)
select
  m.id as market_id,
  g.slug as group_slug,
  m.spec,
  m.status,
  m.price_provenance,
  m.quote_probability,
  m.quote_multiplier,
  m.currency,
  coalesce(pt.back_pot_lamports, 0)::bigint::text as back_pot_lamports,
  coalesce(pt.doubt_pot_lamports, 0)::bigint::text as doubt_pot_lamports,
  coalesce(match_totals.matched_back_lamports + match_totals.matched_doubt_lamports, 0)::bigint::text as matched_amount_lamports,
  coalesce(lt.refunded_amount_lamports, 0)::bigint::text as refunded_amount_lamports,
  coalesce(lt.paid_amount_lamports, 0)::bigint::text as paid_amount_lamports,
  coalesce(pt.position_count, 0)::bigint as position_count,
  m.created_at,
  s.outcome,
  s.deciding_seq,
  s.evidence_seqs,
  s.tier,
  s.settled_at,
  p.status as proof_status,
  p.explorer_url,
  p.validate_stat_tx,
  p.merkle_proof,
  p.stat_key,
  p.seq as proof_seq
from markets m
join groups g on g.id = m.group_id
left join position_totals pt on pt.market_id = m.id
left join ledger_totals lt on lt.market_id = m.id
left join lateral (
  select greatest(round(((1 - m.quote_probability) / m.quote_probability) * 1000)::bigint, 1) as ratio_milli
) ratio on true
left join lateral (
  select least(
    coalesce(pt.active_back_lamports, 0),
    (coalesce(pt.active_doubt_lamports, 0) * 1000) / ratio.ratio_milli
  ) as matched_back_lamports
) match_back on true
left join lateral (
  select
    match_back.matched_back_lamports,
    least(
      coalesce(pt.active_doubt_lamports, 0),
      (match_back.matched_back_lamports * ratio.ratio_milli) / 1000
    ) as matched_doubt_lamports
) match_totals on true
left join settlements s on s.market_id = m.id
left join lateral (
  select
    pr.status,
    pr.explorer_url,
    pr.validate_stat_tx,
    pr.merkle_proof,
    pr.stat_key,
    pr.seq
  from proofs pr
  where pr.market_id = m.id
  order by
    case pr.status
      when 'verified' then 4
      when 'pending' then 3
      when 'failed' then 2
      when 'unavailable' then 1
      else 0
    end desc,
    case pr.kind when 'stat' then 1 else 0 end desc,
    pr.id asc
  limit 1
) p on true
where g.web_enabled and m.currency = 'sol' and not m.is_replay;

grant select on public_receipts to anon, authenticated;
