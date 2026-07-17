# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Called It, a Telegram betting broker for friends' group chats during the World Cup, built for the Superteam World Cup Hackathon on TxLINE (TxODDS) + Solana **devnet only**. "Callie" watches the chat; when someone makes a claim ("Mbappé scores twice today") she parses it with an LLM, prices it off the live TxLINE feed, mints a market, and posts one offer card with Back / Against buttons. Members stake devnet SOL, a pure reducer settles the market from feed evidence, and receipts get TxLINE Merkle proofs verifiable in the browser against a Solana-published root.

**Product pivot (commit `7c474ee`, 2026-07-09):** the original play-money "Rep" scorekeeping product was rewritten into a SOL-only peer-matched broker, no Rep, no leaderboard, no prove→confirm ceremony. Docs written before then describe the old product (see "Doc trust order" below). The pivot commit message is the best prose description of the current mechanics.

## Commands

Toolchain: Node 24 (`.nvmrc`; root engines say >=22, concierge requires >=24), pnpm `10.33.0` (pinned via `packageManager`, a mismatched global pnpm breaks root commands).

```bash
pnpm install --frozen-lockfile
pnpm typecheck                     # turbo, all workspaces
pnpm test                          # vitest everywhere; turbo builds dependencies first (test dependsOn ^build)
pnpm build                         # all workspaces EXCEPT concierge (callie has no `build` script)
pnpm --filter callie eve:build     # concierge builds via eve

# Scoped runs, package names: @calledit/{engine,web,market-engine,txline,agent,db,solana} and callie
pnpm --filter @calledit/market-engine test
pnpm --filter @calledit/engine exec vitest run src/wager/pot.test.ts    # single file
pnpm --filter @calledit/engine exec vitest run -t "settles pro-rata"    # single test by name

# Dev
pnpm --dir apps/web exec next dev --hostname 127.0.0.1 --port 3020
pnpm --filter @calledit/engine dev   # WARNING: with a real .env this connects to live Telegram/TxLINE
pnpm bootstrap:txline                # one-shot TxLINE devnet activation; prints env values
```

CI (`.github/workflows/ci.yml`) runs exactly: install → typecheck → test → build → `callie eve:build`.

## Architecture

pnpm/Turbo monorepo: three deployables, five packages, one strict data-flow direction. The engine is the **single writer**; everything else reads or goes through its API.

- **`apps/engine`** (`@calledit/engine`, Railway), one long-running Node process: grammY bot + TxLINE ingest supervisor + settlement loop + proof worker + crons + a small bearer-auth HTTP API (`src/api/server.ts`, only `/api/health` is open) + the wager module. Modules depend on the `Deps` ports type (`src/ports.ts`); `src/wiring.ts` is the **only** file that imports and adapts sibling packages. Boot (`src/main.ts`) zod-validates env and **fails loud if the wager module is unwired** (SOL is the only currency now).
- **`apps/web`** (`@calledit/web`, Vercel), Next.js 15 App Router. Receipt `/r/[marketId]`, group page `/g/[slug]`, landing `/`. Reads **only** `public_*` Supabase views with the anon key; no auth, no writes; pages degrade instead of white-screening. Browser proof re-verification must import the `solana-verify-bridge` alias (`next.config.ts` maps it to the built verifier or a graceful fallback), never `@calledit/solana/verify` directly.
- **`apps/concierge`** (`callie`, separate Railway service), Eve-powered conversational agent (GLM via Anthropic-compatible AI SDK provider). Deliberately isolated: imports **no** `@calledit/*` packages; its tools call the engine HTTP API only; user identity comes from `telegramIdentity(ctx.session)`, never from model output; shell/fs/web tools are disabled. Single-ingress mode: one Telegram bot serves both cards and Callie (`TELEGRAM_INGRESS=poll|webhook`; webhook requires `ENGINE_API_TOKEN`; Telegram privacy mode must be off).
- **`packages/market-engine`**, the pure deterministic core: claim compiler (`compileClaim`), pricing (`priceSpec`), settlement state machine (`reduceMarket`). **No I/O, no clocks, no env reads**, the engine persists state and applies the reducer's effects. All shared domain types and constants come from here; never duplicate its unions elsewhere. The most-tested code in the repo.
- **`packages/txline`**, typed TxLINE client, `LiveSource` (SSE with Last-Event-ID resume + gap-fill) and `ReplaySource` (virtual clock over `asOf` snapshots, diffs into events), payload normalizers. Never commit real TxLINE feed data; test fixtures are synthesized.
- **`packages/agent`**, deterministic `prefilter` (kills >95% of messages before any LLM), GLM `classifyMessage`/`parseClaim` (injectable clients; golden-set harness, no live API in CI, `AGENT_LIVE=1` opts in), `persona` templates with a deny-list guard.
- **`packages/db`**, Supabase migrations + thin typed service-role facade; no business logic. Migrations are numbered and additive: `0001_init`, `0002_wager`, `0003_broker_pivot`. **0003 must be applied to the live Supabase before deploying the pivoted engine** (wager_stake RPC signature changed).
- **`packages/solana`**, txoracle client (TxL mint is Token-2022, so use `TOKEN_2022_PROGRAM_ID` for ATA derivation), activation signing, and an **isomorphic** Merkle verifier (`src/verify.ts`, no node-only imports, so the web bundles it).

### Event flow (settlement truth)

TxLINE feed → normalize to `MatchEvent`s → `insertFeedEvent` (dedupe on `(fixture_id, seq)`) → `reduceMarket` (pure: freezes on VAR/suspension, debounces, handles goal-discard/amend reversals, delay-snipe voids) → Settler applies effects to DB + chat cards → proof worker fetches TxLINE stat validation and submits on-chain **best-effort**. Proof failure never blocks or reverses settlement, it only downgrades the receipt's trust tier.

### Money flow (wager module, `apps/engine/src/wager/`)

Custodial devnet-SOL: engine-held treasury keypair (must differ from `SOLANA_KEYPAIR_B58`, sponsor terms forbid the TxL wallet as wagering collateral). Deposits watched on-chain and keyed `(tx_sig, ix_index)`; withdrawals via an outbox with pre-broadcast persisted signatures and `searchTransactionHistory: true` re-checks. `pot.ts` is pure and property-tested: FOR/AGAINST pots, the mint-time price **locks** the settlement ratio (so `reprice()` no-ops for SOL and one-market-per-claim must hold inside the claim lock), pro-rata credits, conservation invariant. Stakes are serialized per `(market, user)` via Postgres advisory locks; solvency is an escrow-inclusive coverage check with a persisted circuit breaker. All lamports are safe integers.

### Replay mode (the demo path)

`/replay <fixtureId>` (group admin) drives a `ReplaySource` through a historical fixture at speed. This is how the product is demoed off-season, so it must keep working. Replay start resets fixture state (clears `feed_events`, rewinds `last_seq`); claim parsing is pinned to the replay fixture to resolve ambiguous team names; zero-bet markets don't block a new replay.

## Conventions that are enforced here

- TypeScript strict everywhere, most workspaces with `noUncheckedIndexedAccess`; ESM with explicit `.js` import specifiers in Node-compiled TS.
- Every mutation reachable from Telegram callbacks, the API, or Eve must be idempotent, so retries replay steps (client idempotency keys on stakes, upsert-ignore on feed events, deterministic ledger idempotency keys).
- Bot copy goes through `createSay`/`persona` templates or dedicated copy modules (`wager/copy.ts` for money strings). Post-pivot the register is broker voice, so bet/stake/against/SOL are allowed; the persona deny-list still guards LLM garnish.
- Env contract is `.env.example`, read exactly those names, with two known gaps: `WAGER_TREASURY_KEYPAIR_B58` (required at boot) and `WAGER_OPS_CHAT_ID` are consumed by `apps/engine/src/env.ts` but missing from the example file, and `apps/web` additionally reads `NEXT_PUBLIC_TELEGRAM_GROUP_URL` and `NEXT_PUBLIC_SAMPLE_RECEIPT_URL`. The engine loads the repo-root `.env` (walks up from `src`/`dist`); values already present in the process env win; production hosts inject env directly. Never read or print `.env` or `apps/web/.env.local`.
- Deploys: engine via root `railway.json`, concierge via `apps/concierge/railway.json`, web via `apps/web/vercel.json` (each service roots its own config).

## Doc trust order

1. This file, the nested `CLAUDE.md` files (`apps/engine`, `apps/web`, `apps/concierge`, `packages/`), the code, and commit `7c474ee`'s message: current.
2. Per-directory `AGENTS.md` (root, engine, web, concierge), accurate "where to look" maps and gotchas, but generated pre-pivot: ignore their Rep-era copy rules, the claim that wager mode is "optional" (it is mandatory at boot), and the `npx pnpm@10.33.0` workaround (a matching pnpm is on PATH).
3. `README.md`, `CONTRACTS.md`, `docs/` (PRD, wager-feature-design, eve-concierge-plan), pre-pivot product story and original build contracts. Useful for the runbook, TxLINE integration details, and design rationale; wrong about Rep, leaderboards, and the confirm ceremony.
