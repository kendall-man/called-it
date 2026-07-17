# PROJECT KNOWLEDGE BASE

Contract refreshed: 2026-07-18 (consolidated `main` at `de5d41b`)

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
  oracle-signer/    Isolated attestation signer with journaled, verified requests
  escrow-recovery/  Explicit recovery CLI; never part of normal request handling
  mockline/         Opt-in deterministic TxLINE twin for staging journeys
packages/
  market-engine/  Pure deterministic claim compiler, pricing, settlement reducer
  txline/         TxLINE client, SSE/replay sources, payload normalization
  agent/          GLM classify/parse/persona plus deterministic prefilter
  db/             Supabase schema, row types, service-role facades
  solana/         Txoracle/devnet client, wallet helpers, isomorphic proof verification
  escrow-sdk/     Canonical escrow codecs, addresses, transactions, verification vectors
  escrow-integration/  Local-validator scenario and recovery harness
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
| Escrow runtime | `apps/engine/src/escrow/`, `packages/escrow-sdk/PROTOCOL.md` | Durable relayers, attestations, finality, reconciliation |
| Oracle isolation | `apps/oracle-signer/` | Verify before signing; journal every accepted request |
| Recovery | `apps/escrow-recovery/`, `apps/engine/src/escrow/recovery-*` | Explicit, resumable, finalized-state-first |
| Bot flow/cards/callbacks | `apps/engine/src/bot/`, `apps/engine/src/pipeline/` | Consumer-facing copy has strict vocabulary rules |
| Engine HTTP API | `apps/engine/src/api/server.ts` | Route-scoped private API; only `/api/live` and `/api/ready` are public |
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

`pnpm build` covers all buildable workspaces. Keep `pnpm --filter callie eve:build`
as the explicit concierge deployment check because Eve discovery has separate constraints.

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

## Verified 2026-07-18

- Consolidated escrow merge: web production build passed; engine suite reached 1,008 tests
  after replay/privacy fixture corrections; focused repaired suites passed 81/81.
- Mockline: 26/26 tests plus typecheck passed.
- Compatible onboarding operations: web typecheck, Solana 122/122 tests, scripts typecheck,
  and 28 focused operations tests passed.
- Full final verification remains `pnpm verify`; it requires local Postgres and the documented
  public build placeholders, never production credentials.

## Conventions

- TypeScript strict everywhere; most workspaces also use `noUncheckedIndexedAccess`.
- ESM and explicit `.js` import specifiers in package/app TS that compiles to Node.
- Domain types flow from `@calledit/market-engine`; do not duplicate unions elsewhere.
- `packages/market-engine` must stay pure: no I/O, no clocks, no environment reads.
- The engine is the single writer. Web reads public views; concierge reads scoped engine
  routes and forwards Telegram ingress, but has no arbitrary money-mutation route.
- Escrow markets are asset-aware (`sol` or `usdc`); devnet assets have no monetary value.
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
- `.env.example` is the route-scoped env inventory: engine route tokens are separate from
  the concierge private engine origin and the server-only web bridge token.
- README says Node >=22, while `apps/concierge/package.json` declares Node >=24.
- LSP TypeScript server was not installed in this session; rely on `tsc`/Turbo for diagnostics.
- CI is tracked in `.github/workflows/{ci,escrow,security}.yml`; keep actions pinned.
- `apps/concierge` uses locked-down Eve tools and intentionally imports no `@calledit/*` packages.
- Migrations extend through escrow/shared-indexing waves. Apply strictly in filename order;
  never infer production state from the old `0002_wager.sql` warning alone.
- Historical migrations and dormant compatibility code may retain `Rep` names; historical
  fields are not consumer guidance or a supported economy and stay outside the copy gate.
- `apps/web/next.config.ts` aliases `solana-verify-bridge` to the built Solana verifier when
  available, otherwise to a graceful fallback.
