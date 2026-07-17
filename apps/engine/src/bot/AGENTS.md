# TELEGRAM BOT SURFACE

## Scope

grammY assembly, commands, callbacks, cards, consent, onboarding, copy, and bounded delivery.

## Flow

`bot.ts` registers error handling, scoped commands, lifecycle, first-touch context, commands,
wager commands, callbacks, then passive detection. Keep this order intentional.

## Invariants

- Group commands ensure group/user context before handlers; commands bypass passive detection.
- Passive/friend-triggered claims require speaker consent; explicit own `/bookit` can proceed.
- Callback payloads stay within Telegram byte limits and decode fail-closed.
- Every callback is idempotent; duplicate taps cannot create another economic job.
- Escrow signing tokens and wallet actions go only to private chat.
- Group cards use bounded participant aliases; never raw Telegram or provider identifiers.
- Copy states what changed, whether assets moved, and one recovery action.
- Use `message-budget.ts` and `SendQueue`; do not bypass rate limits with direct sends.
- Replay stakes call `admitReplayPosition` before pricing/cutoff checks.

## Checks

```bash
pnpm --filter @calledit/engine exec vitest run src/bot
pnpm --filter @calledit/engine typecheck
pnpm verify:product-copy
```
