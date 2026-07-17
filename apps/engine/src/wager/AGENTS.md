# LEGACY / STARTER WAGER MODULE

## Scope

Asset accounting, legacy deposits/withdrawals, starter grants, peer-pot math, solvency, and
settlement application. Escrow custody paths live in sibling `escrow/` and take precedence.

## Invariants

- All amounts are bigint atomic units internally; cross to number only after safe-integer checks.
- Treasury key differs from the TxLINE/proof key. Never expose treasury details in group chat.
- `/wallet`, `/deposit`, `/withdraw` are private-chat operations; group attempts move nothing.
- Deposit identity is `(signature, instruction index)` and credit is idempotent.
- Persist signed withdrawal bytes before broadcast; full-history status precedes any re-sign.
- Stake/ledger/position writes share deterministic idempotency keys and database locks.
- `pot.ts` is pure and conservative: payouts plus refunds never exceed escrow except flooring dust.
- Solvency circuit breakers stop new exposure; they do not block settlement or withdrawals.
- Replay positions require active run admission and virtual-time cutoff checks.

## Where To Edit

- Public port: `port.ts`; DB adapter: `port-db.ts`; assembly: `module*.ts`.
- Accounting: `stake.ts`, `settlement.ts`, `deposits.ts`, `withdrawals.ts`, `solvency.ts`.
- Copy/formatting: `copy.ts`, `format.ts`; keep asset/network labels explicit.
- Tests use `fakes.ts`; preserve crash-at-every-arrow coverage.

## Checks

```bash
pnpm --filter @calledit/engine exec vitest run src/wager
pnpm --filter @calledit/engine typecheck
```
