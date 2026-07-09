# apps/web

## Overview

Next.js 15 App Router surface for direct Telegram installation, private account recovery,
aggregate group boards, and public receipts. Browser code never writes Supabase directly.

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| Landing page | `app/page.tsx` | One real Add to Telegram group action |
| Receipt page | `app/r/[marketId]/page.tsx` | Dynamic receipt, evidence, trust badge |
| Group board | `app/g/[slug]/page.tsx` | Active SOL calls, aggregates, recent receipts |
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
- Browser code has no direct database or engine writes. Account/event mutations go only
  through same-origin server routes with trusted server-side credentials.
- Installation is setup: the real add action leads to one committed ready message. The only
  activation events are `group_ready` after that commit and `position_placed` after a
  position commit.
- An explicit speaker call may proceed. Passive or friend-triggered text publishes nothing
  until the speaker confirms.
- Offer rendering uses exactly `It happens · 0.01 SOL`,
  `It does not · 0.01 SOL`, and `Choose amount`.
- The limited starter grant may fund only an eligible exact first 0.01 test-SOL position,
  commits atomically with it, is disabled by default, and has no monetary value.
- Follow root `DESIGN.md`: one `h1`, zero negative letter spacing, visible focus, 44px
  targets, reduced motion, and reflow without horizontal page scroll at 320px.
- The landing primary action is the validated versioned Telegram add URL. No demo or replay
  onboarding and no placeholder destination may appear.
- `/me`/account is private requester state; `/table`/group pages contain aggregate SOL only.
- Receipts render the confirmed speaker's stable per-group alias and deterministic
  `market.spec` terms. Never fall back to raw `quoted_text`.
- Every error says what happened, whether SOL/state changed, and one next action.

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
- Historical `Rep` receipt fields are dormant compatibility input only; historical values
  are not a current board, ranking, or consumer economy.
