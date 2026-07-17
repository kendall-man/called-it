# Called It Local Telegram E2E

## Recover the intended baseline

1. Run `pnpm recovery -- report`.
2. Prefer the latest remote-backed feature branch matching the test goal.
3. For the historical escrow flow, `8522ed9` introduced the stable engine/web launcher and webhook proxy; later fixes are on `codex/telegram-escrow-e2e`.
4. Never use a vanished `/tmp` worktree as the source of truth.

## Prepare

1. Create `.calledit-local/runtime.env` from the selected branch's `.env.example`; set mode `0600`.
2. Start or verify PostgreSQL/PostgREST/Supabase compatibility, Surfpool or devnet RPC, and fixture data using branch-owned scripts.
3. For Surfpool escrow, use the branch-owned bootstrap to configure a fresh three-key local oracle set with threshold 2-of-3. Verify key presence and public-key matching without printing key material. Do not deploy remote oracle services.
4. Run `pnpm local:preflight`. Resolve every missing command, credential name, route, and worktree mismatch before startup.

## Start and expose

1. Start `pnpm local:stack -- --webhook`.
2. Confirm engine health/readiness and web HTTP 200 locally.
3. Run `pnpm local:tunnel -- start`.
4. Restart the stack once so the generated `WEB_BASE_URL` is loaded.
5. Run `pnpm local:webhook -- set`, then `pnpm local:webhook -- status`.
6. Add the current tunnel origin to Privy's allowed origins only when testing Privy; quick-tunnel URLs change after restart.

## Prove one flow

Use one fresh Telegram group command, one market/session ID, and one expected terminal state. Record redacted evidence at ingress, persistence, chain/indexer, and Telegram delivery boundaries. Do not create parallel fixtures while diagnosing one failure.

For a winning escrow path, require this sequence: placement finalized, position active, replay terminal, 2-of-3 freeze/settlement attestations accepted, settlement finalized, winner claim paid, and final receipt rendered. If oracle keys are missing or do not match the on-chain set, stop at that boundary and report partial evidence; do not substitute public-devnet remote signers.

## Stop or hand off

1. Capture status, branch, commit, service PIDs, public origin, webhook endpoint, and unresolved boundary.
2. Run `pnpm local:webhook -- clear` before returning to polling or production ingress.
3. Run `pnpm local:tunnel -- stop`.
4. Run `pnpm recovery -- bundle` for a committed-state checkpoint when needed.
5. Never store tokens, private keys, Railway exports, or raw runtime env in evidence or Git.
