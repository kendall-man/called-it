# packages/db

## Overview

Supabase schema, hand-written row types, and thin service-role data facades for the
engine and wager mode. No business logic should live here beyond DB atomicity helpers.

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| Initial schema | `migrations/0001_init.sql` | Core tables, public views, RLS |
| Wager schema | `migrations/0002_wager.sql` | Devnet SOL add-on; separate project only |
| Engine facade | `src/engine-db.ts` | Groups, fixtures, claims, markets, ledger, proofs |
| Wager facade | `src/wager-db.ts` | SOL ledger/deposits/withdrawals/RPC wrappers |
| Core row types | `src/types.ts` | Mirrors 0001 schema |
| Wager row types | `src/wager-types.ts` | Mirrors 0002 schema |

## Conventions

- Engine uses service_role and bypasses RLS; web reads only curated public views.
- Keep this as a data layer. Domain decisions belong in `market-engine` or `apps/engine`.
- Idempotency keys are part of correctness, especially for Telegram/Eve retries.
- Wager RPC constants must stay in sync with `apps/engine/src/wager/constants.ts`.

## Commands

```bash
npx -y pnpm@10.33.0 --filter @calledit/db typecheck
npx -y pnpm@10.33.0 --filter @calledit/db test
npx -y pnpm@10.33.0 --filter @calledit/db build
```

## Gotchas

- `0002_wager.sql` explicitly says not to apply it to the hackathon Supabase project.
- Wager tables have RLS enabled with zero anon policies and no public views.
