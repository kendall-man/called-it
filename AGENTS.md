# PROJECT KNOWLEDGE BASE

Contract refreshed: 2026-07-10

## Overview

Called It is a pnpm/Turbo TypeScript monorepo for a SOL-only Telegram football-call beta.
The engine detects, prices, and settles consented group calls from TxLINE data; the web app
provides direct group installation, private account recovery, aggregate boards, and public
receipts; the concierge adds an Eve-powered conversational surface over the engine API.

## Structure

```
apps/
  engine/      Long-running grammY process, TxLINE ingest, settlement, proofs, HTTP API
  web/         Next.js App Router add/account/board/receipt surface; curated public views
  concierge/  Eve agent/webhook surface that talks only to the private engine HTTP API
packages/
  market-engine/  Pure deterministic claim compiler, pricing, settlement reducer
  txline/         TxLINE client, SSE/replay sources, payload normalization
  agent/          GLM classify/parse/persona plus deterministic prefilter
  db/             Supabase schema, row types, service-role facades
  solana/         Txoracle/devnet client, wallet helpers, isomorphic proof verification
scripts/
  bootstrap-txline.ts  Devnet TxLINE activation helper
```

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| Product intent/runbook | `README.md`, `docs/PRD-called-it-mvp.md` | SOL-only direct journey is authoritative |
| Visual/interaction rules | `DESIGN.md` | Required before changing user-facing UI |
| Cross-package contracts | `CONTRACTS.md` | Consent, money, privacy, and app boundaries |
| Engine boot/wiring | `apps/engine/src/main.ts`, `apps/engine/src/wiring.ts` | `wiring.ts` is the only direct sibling-package import hub |
| Bot flow/cards/callbacks | `apps/engine/src/bot/`, `apps/engine/src/pipeline/` | Consumer-facing copy has strict vocabulary rules |
| Engine HTTP API | `apps/engine/src/api/server.ts` | Concierge integration surface; bearer-auth except `/api/health` |
| Settlement truth | `packages/market-engine/src/reduce.ts` | Pure state machine; engine persists/applies effects |
| Public web receipts | `apps/web/app/r/[marketId]/page.tsx`, `apps/web/lib/queries.ts` | Aliases, compiled terms, aggregate SOL only |
| Concierge agent/tools | `apps/concierge/agent/` | No workspace imports; tools call the engine API |
| DB schema/RLS | `packages/db/migrations/0001_init.sql`, `0002_wager.sql` | `0002_wager.sql` is devnet-wager only |

## Commands

Use the repo-declared pnpm version. In this Codex shell, PATH had pnpm 11.7.0 and
root commands failed until run through pnpm 10.33.0.

```bash
npx -y pnpm@10.33.0 install
npx -y pnpm@10.33.0 typecheck
npx -y pnpm@10.33.0 test
npx -y pnpm@10.33.0 exec turbo run build --force
npx -y pnpm@10.33.0 --filter callie eve:build
npx -y pnpm@10.33.0 verify:product-copy
```

Important: root `build` runs seven buildable packages and skips `callie`, because
the concierge script is named `eve:build`, not `build`.

Web local smoke:

```bash
npx -y pnpm@10.33.0 --dir apps/web exec next dev --hostname 127.0.0.1 --port 3020
```

## Verified 2026-07-08

- Forced typecheck and tests: `npx -y pnpm@10.33.0 exec turbo run typecheck test --force`
  passed with 21 tasks, 0 cached.
- Forced build: `npx -y pnpm@10.33.0 exec turbo run build --force` passed for seven
  packages including Next production build.
- Concierge build: `npx -y pnpm@10.33.0 --filter callie eve:build` passed.
- Web dev server: `/` returned 200; `/r/not-a-uuid`, `/r/00000000-0000-0000-0000-000000000000`,
  and `/g/missing-group` returned intentional 404 pages.
- Browser smoke: Brave rendered the landing page at `http://127.0.0.1:3020/` with the
  expected headings, CTA links, and trust strip visible in the accessibility tree.
- Engine API smoke against mock deps: `/api/health` returned 200 and unauthenticated
  `/api/fixtures` returned 401.

## Conventions

- TypeScript strict everywhere; most workspaces also use `noUncheckedIndexedAccess`.
- ESM and explicit `.js` import specifiers in package/app TS that compiles to Node.
- Domain types flow from `@calledit/market-engine`; do not duplicate unions elsewhere.
- `packages/market-engine` must stay pure: no I/O, no clocks, no environment reads.
- The engine is the single writer. Web reads public views; concierge mutates only via engine API.
- SOL/test SOL is the only current economy. Test SOL has no monetary value.
- Installation is setup; one real ready message and a consented live offer are onboarding.
- Explicit author mentions/own `/bookit` proceed; passive or friend-triggered calls require
  owner-only confirmation before any market or public quote exists.
- Default offer labels are exactly `It happens · 0.01 SOL`,
  `It does not · 0.01 SOL`, and `Choose amount`.
- The limited starter grant may fund only an eligible exact first 0.01 test-SOL position,
  commits atomically with it, is disabled by default, and has no monetary value.
- `group_ready` and `position_placed` are the only activation events.
- `/me` is private requester state; `/table` is the aggregate group board.
- Public receipts use the confirmed speaker's stable group alias plus deterministic terms
  from `market.spec`; raw `quoted_text` remains private.
- Every failure says what happened, whether SOL/state changed, and one next action.

## Gotchas

- Do not read or print `.env` values. `.env.example` is safe and documents the public contract.
- `.env.example` currently does not list every optional env used by newer engine/concierge code
  (`ENGINE_API_TOKEN`, `TELEGRAM_INGRESS`, concierge `ENGINE_API_URL`, etc.).
- README says Node >=22, while `apps/concierge/package.json` declares Node >=24.
- LSP TypeScript server was not installed in this session; rely on `tsc`/Turbo for diagnostics.
- There is no `.github/workflows` CI in the tracked tree.
- `apps/concierge` uses locked-down Eve tools and intentionally imports no `@calledit/*` packages.
- `packages/db/migrations/0002_wager.sql` says not to apply it to the hackathon Supabase project.
- Historical migrations and dormant compatibility code may retain `Rep` names; historical
  fields are not consumer guidance or a supported economy and stay outside the copy gate.
- `apps/web/next.config.ts` aliases `solana-verify-bridge` to the built Solana verifier when
  available, otherwise to a graceful fallback.
