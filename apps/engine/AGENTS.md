# apps/engine

## Overview

Single long-running Node process: grammY bot, TxLINE ingest supervisor, settlement loop,
proof worker, cron jobs, optional wager module, and the small authenticated HTTP API.

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| Boot/shutdown | `src/main.ts` | Loads repo-root `.env`, validates env, wires bot/API/crons |
| Dependency ports | `src/ports.ts`, `src/wiring.ts` | `wiring.ts` adapts all sibling packages |
| Bot commands/callbacks | `src/bot/` | `callbacks.ts` and `commands.ts` own Telegram UX |
| Claim pipeline | `src/pipeline/` | Parse/compile/quote/mint/stake helpers |
| Ingest | `src/ingest/` | Live/replay source supervision and fixture mapping |
| Settlement | `src/settle/settler.ts` | Applies market-engine reducer effects to DB/chat |
| Proofs | `src/proofs/` | TxLINE stat proof fetch, Solana submit, proof rows |
| HTTP API | `src/api/server.ts` | Concierge-facing API; token auth except health |
| Wager mode | `src/wager/` | Devnet SOL, separately gated, treasury keypair only |

## Conventions

- Keep business rules in `@calledit/market-engine` where possible; engine applies side effects.
- Keep package imports centralized in `wiring.ts`; most modules should depend on `Deps`/ports.
- Bot copy routes through `createSay`/persona or dedicated copy modules.
- Mutations must be idempotent where Telegram/Eve retries can replay a step.
- Do not let proof failure block or reverse settlement; proofs downgrade/record status.

## Commands

```bash
npx -y pnpm@10.33.0 --filter @calledit/engine typecheck
npx -y pnpm@10.33.0 --filter @calledit/engine test
npx -y pnpm@10.33.0 --filter @calledit/engine build
```

## Gotchas

- Running `src/main.ts` with real env can connect to Telegram/TxLINE. Prefer tests or a small
  API driver for local audits unless intentionally exercising the live bot.
- `TELEGRAM_INGRESS=webhook` requires `ENGINE_API_TOKEN`; polling and webhook cannot both own
  the same Telegram token.
- `WAGER_TREASURY_KEYPAIR_B58` must never equal `SOLANA_KEYPAIR_B58`; env validation rejects it.
- Wager copy intentionally uses SOL/devnet terms, but normal Rep product copy should avoid
  gambling and cash-out language.
