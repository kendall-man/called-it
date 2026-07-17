# PROJECT KNOWLEDGE BASE

Generated: 2026-07-08
Branch: main
Commit: efce761

## Overview

Called It is a pnpm/Turbo TypeScript monorepo for a Telegram football-claim product:
the engine detects and settles group-chat calls from TxLINE data, the web app renders
public receipts, and the concierge app adds an Eve-powered conversational surface.

## Structure

```
apps/
  engine/      Long-running grammY process, TxLINE ingest, settlement, proofs, HTTP API
  web/         Next.js App Router receipt/leaderboard site, read-only public Supabase views
  concierge/  Eve agent/webhook surface that talks only to the engine HTTP API
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
| Product intent/runbook | `README.md`, `docs/PRD-called-it-mvp.md` | README omits newer concierge details |
| Cross-package contracts | `CONTRACTS.md` | Still useful, but predates some integrated/wager work |
| Engine boot/wiring | `apps/engine/src/main.ts`, `apps/engine/src/wiring.ts` | `wiring.ts` is the only direct sibling-package import hub |
| Bot flow/cards/callbacks | `apps/engine/src/bot/`, `apps/engine/src/pipeline/` | Consumer-facing copy has strict vocabulary rules |
| Engine HTTP API | `apps/engine/src/api/server.ts` | Concierge integration surface; bearer-auth except `/api/health` |
| Settlement truth | `packages/market-engine/src/reduce.ts` | Pure state machine; engine persists/applies effects |
| Public web receipts | `apps/web/app/r/[marketId]/page.tsx`, `apps/web/lib/queries.ts` | Reads only `public_*` Supabase views |
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
```

Important: root `build` runs seven buildable packages and skips `callie`, because
the concierge script is named `eve:build`, not `build`.

Web local smoke:

```bash
npx -y pnpm@10.33.0 --dir apps/web exec next dev --hostname 127.0.0.1 --port 3020
```

Deterministic local Telegram loop:

```bash
npx -y pnpm@10.33.0 local:preflight
npx -y pnpm@10.33.0 local:stack -- --webhook
npx -y pnpm@10.33.0 local:tunnel -- start
npx -y pnpm@10.33.0 local:webhook -- set
```

Read `.agents/skills/calledit-local-telegram/SKILL.md` before running this flow.
Runtime credentials belong only in `.calledit-local/runtime.env`; commands must
report variable presence, never values. Use `pnpm recovery -- report` before
discarding a worktree and `pnpm recovery -- bundle` for a committed-state backup.

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
- Consumer copy should say "calls", "Rep", "multiplier", "proof"; avoid betting-slip copy,
  odds notation, and currency language outside internal wager-mode code.

## Gotchas

- Do not read or print `.env` values. `.env.example` is safe and documents the public contract.
- `.env.example` currently does not list every optional env used by newer engine/concierge code
  (`ENGINE_API_TOKEN`, `TELEGRAM_INGRESS`, concierge `ENGINE_API_URL`, etc.).
- README says Node >=22, while `apps/concierge/package.json` declares Node >=24.
- LSP TypeScript server was not installed in this session; rely on `tsc`/Turbo for diagnostics.
- There is no `.github/workflows` CI in the tracked tree.
- `apps/concierge` uses locked-down Eve tools and intentionally imports no `@calledit/*` packages.
- `packages/db/migrations/0002_wager.sql` says not to apply it to the hackathon Supabase project.
- `apps/web/next.config.ts` aliases `solana-verify-bridge` to the built Solana verifier when
  available, otherwise to a graceful fallback.
