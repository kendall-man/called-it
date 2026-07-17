# apps/engine

## Overview

Single long-running Node process for the SOL-only beta: grammY behavior, TxLINE ingest,
test-SOL positions, settlement, proofs, durable jobs, cron work, and the private HTTP API.

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
| HTTP API | `src/api/server.ts` | Route-scoped private API; public live/ready only |
| SOL positions | `src/wager/` | Devnet SOL, independently gated, treasury keypair only |

## Conventions

- Keep business rules in `@calledit/market-engine` where possible; engine applies side effects.
- Keep package imports centralized in `wiring.ts`; most modules should depend on `Deps`/ports.
- Bot copy routes through `createSay`/persona or dedicated copy modules.
- Mutations must be idempotent where Telegram/Eve retries can replay a step.
- Do not let proof failure block or reverse settlement; proofs downgrade/record status.
- Emit `group_ready` only after the one ready marker/message commits and
  `position_placed` only after the position commits. They are the only activation events.
- Explicit author mentions or the author's own `/bookit` may proceed. Passive or
  friend-triggered calls publish nothing until the owner confirms within two minutes.
- Default offers use exactly `It happens · 0.01 SOL`,
  `It does not · 0.01 SOL`, and `Choose amount`.
- Starter support is limited to an eligible exact first 0.01 test-SOL position, commits in
  the same transaction, is disabled by default, and has no monetary value.
- `/me` never exposes account data in a group; `/table` resolves aggregate group state.
- Public receipt inputs are the stable group alias and deterministic `market.spec`, never
  raw `claims.quoted_text`.
- Refusals state what happened, whether SOL/state changed, and one next action.

## Commands

```bash
npx -y pnpm@10.33.0 --filter @calledit/engine typecheck
npx -y pnpm@10.33.0 --filter @calledit/engine test
npx -y pnpm@10.33.0 --filter @calledit/engine build
```

## Gotchas

- Running `src/main.ts` with real env can connect to Telegram/TxLINE. Prefer tests or a small
  API driver for local audits unless intentionally exercising the live bot.
- `TELEGRAM_INGRESS=webhook` means the concierge forwards to `/api/telegram-ingress`
  with the Telegram route token; polling and webhook cannot both own the same Telegram bot.
- `WAGER_TREASURY_KEYPAIR_B58` must never equal `SOLANA_KEYPAIR_B58`; env validation rejects it.
- SOL/test SOL is the only current consumer economy and always carries the no-monetary-value
  notice where setup or funding is explained.
- Historical `Rep` lifecycle modules are dormant compatibility code; historical names must
  not enter active cards, commands, account state, boards, receipts, or concierge guidance.
- Internal replay support is not a current command, onboarding path, or public product
  surface.
