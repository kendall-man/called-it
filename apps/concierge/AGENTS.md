# apps/concierge

## Overview

Eve-powered Telegram concierge ("callie") that handles addressed conversation and calls
the engine HTTP API. It is deliberately additive: the engine remains the source of truth.

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| Agent model/limits | `agent/agent.ts` | GLM via Anthropic-compatible AI SDK provider |
| Telegram ingress | `agent/channels/telegram.ts` | Conversation gating and engine forwarding |
| Engine client | `agent/lib/engine-api.ts` | Typed fetch client and trusted Telegram identity |
| Tools | `agent/tools/` | API-backed tools plus disabled shell/fs/web built-ins |
| Instructions | `agent/instructions/` | Voice, house rules, receipts, replay guidance |
| Plan/rationale | `docs/eve-concierge-plan.md` | Architecture and deployment notes |

## Conventions

- Do not import `@calledit/*` workspace packages here; tools talk to the engine API.
- Never trust model-supplied user identity. Use `telegramIdentity(ctx.session)`.
- Mutating tools must rely on engine validation, locks, and idempotency.
- Shell, filesystem, and open-web tools are disabled by design.

## Commands

```bash
npx -y pnpm@10.33.0 --filter callie typecheck
npx -y pnpm@10.33.0 --filter callie test
npx -y pnpm@10.33.0 --filter callie eve:build
```

## Gotchas

- `callie` has no `build` script, so root `turbo run build` skips it.
- `package.json` declares Node >=24, while the repo root says Node >=22.
- Env used here includes `TELEGRAM_BOT_TOKEN`, `CONCIERGE_BOT_USERNAME`,
  `ENGINE_API_URL`, `ENGINE_API_TOKEN`, `GLM_API_KEY`, and optional `GLM_BASE_URL`.
- Telegram privacy mode must be disabled for the single-ingress forwarding design.
