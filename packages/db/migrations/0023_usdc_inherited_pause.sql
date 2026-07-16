-- A legacy global SOL solvency pause was copied to both asset rows by 0022.
-- Clear only the USDC copy when the database proves there is no USDC
-- liability or pending transfer. Manual pauses and active USDC accounts stay
-- untouched.

update public.wager_asset_status
set paused = false,
    reason = null,
    updated_at = now()
where asset = 'usdc'
  and paused
  and reason like 'solvency:%'
  and coalesce((
    select sum(lamports)
    from public.wager_ledger_entries
    where asset = 'usdc'
  ), 0) = 0
  and not exists (
    select 1
    from public.positions p
    join public.markets m on m.id = p.market_id
    where m.currency = 'usdc'
      and m.status in ('pending_lineup', 'open', 'frozen', 'settling')
      and p.state <> 'void'
  )
  and not exists (
    select 1
    from public.wager_withdrawals
    where asset = 'usdc'
      and state in ('debited', 'submitted')
  );
