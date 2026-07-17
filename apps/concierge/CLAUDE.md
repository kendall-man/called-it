# apps/concierge, "callie", the eve conversational layer

Deliberately isolated from the monorepo: it imports no `@calledit/*` packages, has no DB
access, and talks to the world only through (a) the shared Telegram bot token and (b) the
engine HTTP API (`agent/lib/engine-api.ts`, bearer `ENGINE_API_TOKEN`). The engine stays
the single source of truth. Callie proposes, the engine disposes.

## Shape

Eve framework (`eve` package) auto-discovers everything under `agent/`:
- `agent/agent.ts`, model config: GLM `glm-4.6` through its Anthropic-compatible
  endpoint (`GLM_BASE_URL`). `modelContextWindowTokens` is REQUIRED (GLM is not in the
  gateway catalog, so removing it breaks the compaction build). Session caps and subagent
  depth 1 are runaway guards.
- `agent/instructions/*.md`, concatenated alphabetically into one system prompt (the
  `00-`/`10-` prefixes are ordering). There are no eve "skills"; edit persona and rules
  here.
- `agent/tools/*.ts`, one file per tool (`get_group_snapshot`, `get_my_wallet`,
  `quote_claim`, `place_stake`, `get_market_status`, `list_todays_matches`). The other
  files are `disableTool()` stubs killing bash, fs, and web. Keep them.
- `agent/channels/telegram.ts`, single-ingress webhook. Conversational updates (private
  chat, or a group @mention that is not a command) start eve sessions. Everything else is
  forwarded verbatim to engine `POST /api/telegram-update`. Callback queries: eve consumes
  its own HITL approval taps and forwards engine card buttons.
- `agent/channels/diag.ts`, a TEMPORARY debug channel (`/diag*`, keyed on
  `ENGINE_API_TOKEN`). It can start sessions with no Telegram auth, so remove it before
  judging.

## Invariants

- **Identity comes from `telegramIdentity(ctx.session)`** (the webhook-derived
  principal), never from model output, so nobody can stake as someone else by naming
  them. Note: eve resumes an approved `place_stake` turn with `auth.current = null`, so
  `telegramIdentity` falls back to `auth.initiator` (also webhook-derived). Without that
  fallback the approved stake fails `no_telegram_identity` (a bug found and fixed during
  the 2026-07-16 wallet E2E). Tools return the `NOT_TELEGRAM` sentinel when no trusted
  principal is present.
- **`place_stake` is HITL-gated**: `approval: () => 'user-approval'` posts a native
  Telegram confirm keyboard before any SOL moves. `idempotencyKey: ctx.callId` means eve
  step-replays cannot double-stake (the engine dedupes).
- Engine 404/409/422 responses are structured data returned to the model, not thrown
  errors, and the model relays the engine's `reply` verbatim. Do not "fix" this.
- Numbers (prices, balances, pots) only ever come from tool results. Instructions forbid
  inventing them or retrying a refused stake with altered params.

## Build, run, deploy

- `pnpm --filter callie dev` (eve dev, which listens on port 2000 with route
  `/eve/v1/telegram`). `eve:build` produces a Nitro server, `eve:start` runs it.
  There is no `build` script, so root `turbo run build` skips callie by design, and CI
  calls `eve:build` explicitly.
- Deployed as its own Railway service (`railway.json` here), a long-running Nitro server,
  not Vercel (the plan doc's Vercel target is stale).
- Only in the serving path when the engine runs `TELEGRAM_INGRESS=webhook`. The two share
  one bot token, and Callie owns the webhook (`TELEGRAM_WEBHOOK_SECRET_TOKEN`).
- Node 24 or newer (stricter than the root's 22 or newer).
- No tests currently (`--passWithNoTests`). `evals/` is referenced by tsconfig but does
  not exist.
