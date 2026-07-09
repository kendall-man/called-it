# apps/concierge

## Overview

Eve-powered Telegram concierge ("callie") for the SOL-only beta. It handles addressed
conversation and calls the private engine HTTP API; the engine remains the sole product and
mutation source of truth.

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| Agent model/limits | `agent/agent.ts` | GLM via Anthropic-compatible AI SDK provider |
| Telegram ingress | `agent/channels/telegram.ts` | Conversation gating and engine forwarding |
| Engine client | `agent/lib/engine-api.ts` | Typed fetch client and trusted Telegram identity |
| Tools | `agent/tools/` | API-backed tools plus disabled shell/fs/web built-ins |
| Instructions | `agent/instructions/` | Direct flow, consent, SOL rules, receipts, voice |
| Plan/rationale | `docs/eve-concierge-plan.md` | Architecture and deployment notes |

## Conventions

- Do not import `@calledit/*` workspace packages here; tools talk to the engine API.
- Never trust model-supplied user identity. Use `telegramIdentity(ctx.session)`.
- Mutating tools must rely on engine validation, locks, and idempotency.
- Shell, filesystem, and open-web tools are disabled by design.
- Installation is setup and the first consented live offer is onboarding; Callie does not
  insert a simulated flow before it.
- A quote is read-only and never substitutes for speaker consent or a committed position.
- Explicit author input may proceed; passive/friend-triggered calls remain owner-confirmed.
- The offer contract is `It happens · 0.01 SOL`, `It does not · 0.01 SOL`, and
  `Choose amount`; never invent a price, side, or amount.
- Starter test SOL has no monetary value, is limited and not guaranteed, and exists only
  with an eligible first committed position.
- `/me` is private requester state. `/table` is aggregate group state. Do not cross them.
- Public receipts use stable group aliases and deterministic compiled terms; never expose
  raw chat, Telegram identity, wallet identity, balance, or individual position data.
- A failure response preserves: what happened, whether SOL/state changed, one next action.

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
- `group_ready` and `position_placed` are the only activation events; Callie must not report
  either before the engine returns the committed transition.
- No demo or replay instruction belongs in the loaded agent bundle.
