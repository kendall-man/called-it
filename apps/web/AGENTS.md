# apps/web

## Overview

Next.js 15 App Router public site for the landing page, receipt pages, and group leaderboard.
It performs no writes and reads only Supabase public views.

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| Landing page | `app/page.tsx` | Static pitch surface |
| Receipt page | `app/r/[marketId]/page.tsx` | Dynamic receipt, evidence, trust badge |
| Group board | `app/g/[slug]/page.tsx` | Leaderboard, hall of calls, recent receipts |
| Queries | `lib/queries.ts` | Defensive Supabase view reads |
| Row mapping | `lib/receipts.ts` | Tolerant public view mappers |
| Spec copy | `lib/spec-terms.ts` | Plain-English market terms |
| Live proof UI | `components/trust-badge.tsx` | Realtime refresh plus browser proof re-check |
| Solana alias | `next.config.ts` | `solana-verify-bridge` real-or-fallback module |

## Conventions

- Pages should degrade rather than white-screen when public env or Supabase data is missing.
- Keep web imports from `@calledit/market-engine` type-only unless an explicit bundle decision
  has been made.
- Browser proof code must import `solana-verify-bridge`, not `@calledit/solana/verify` directly.
- Web has no auth and no client writes.

## Commands

```bash
npx -y pnpm@10.33.0 --filter @calledit/web typecheck
npx -y pnpm@10.33.0 --filter @calledit/web test
npx -y pnpm@10.33.0 --filter @calledit/web build
npx -y pnpm@10.33.0 --dir apps/web exec next dev --hostname 127.0.0.1 --port 3020
```

## Gotchas

- `apps/web/.env.local` is ignored and may contain real public deployment values. Do not print it.
- Valid-shaped missing receipt/group routes intentionally return 404.
- `next build` reads `.env.local` in local runs.
