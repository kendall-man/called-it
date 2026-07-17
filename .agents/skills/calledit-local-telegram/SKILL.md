---
name: calledit-local-telegram
description: Runs Called It locally with deterministic engine/web startup, a managed Cloudflare Tunnel, Telegram webhook registration, and redacted preflight checks. Use when an agent must demo, validate, restart, expose, or troubleshoot the local Telegram bot, Mini App, devnet, Surfpool, or Soft Net flow.
---

# Called It Local Telegram

Use the checked-in commands; do not reconstruct the runtime from transcript snippets.

## Requirements

1. Work from the intended branch/worktree. Run `pnpm local:preflight` first.
2. Put runtime credentials in `.calledit-local/runtime.env` with mode `0600`.
3. Never print this file. Preflight reports names and presence only.
4. For direct webhook testing, use a branch containing either the web webhook proxy or the engine `/api/telegram-webhook` route. The known durable baseline starts at commit `8522ed9`.

## Deterministic loop

Run in separate terminals:

```bash
pnpm local:preflight
pnpm local:stack -- --webhook
pnpm local:tunnel -- start
pnpm local:webhook -- set
pnpm local:webhook -- status
```

Then send one fresh Telegram command and verify one state transition. Use `pnpm local:webhook -- clear` and `pnpm local:tunnel -- stop` when returning the bot to polling or production ingress.

`local:tunnel start` writes only the public URL to `.calledit-local/web-tunnel-url` and `.calledit-local/origin.env`. Restart `local:stack -- --webhook` after the first tunnel creation so `WEB_BASE_URL` uses that origin.

## Local substrate

The launcher owns engine and web only. Database/PostgREST, Supabase compatibility proxy, Surfpool/local validator, and TxLINE fixtures must already pass preflight or be supplied by the selected branch's bootstrap scripts. On the escrow branch, prefer its `escrow:devnet` and evidence-runner commands over ad hoc RPC calls.

## Escrow oracle checkpoint

Before claiming terminal escrow settlement is testable, verify the selected branch's `docs/escrow-operations.md`, `apps/oracle-signer/.env.example`, and engine escrow environment contract. Report names and presence only; never print keys, tokens, or endpoint values.

- Surfpool/local fork: use the engine's documented devnet-only local provider with three distinct test keypairs and a 2-of-3 threshold. Do not deploy HTTPS signer services for a local proof.
- Public devnet: verify three distinct HTTPS signer services, public keys, origins, journals, and a 2-of-3 threshold are documented and configured.
- If neither provider is ready, placement and activation may still be tested, but label terminal freeze, settlement, payout/refund, and final receipt as blocked.

The local keypairs must match the public keys in Surfpool's on-chain oracle set. If they do not, use the branch-owned bootstrap to create a fresh local oracle set; do not patch around the mismatch. This checkpoint is verification-only: do not implement signer code, deploy signer services, or change a public-devnet oracle set unless explicitly requested.

## Stop rules

- One restart per failed component, then diagnose.
- Tunnel startup has a bounded deadline.
- Never run polling while a Telegram webhook is set.
- Never reuse a dead `trycloudflare.com` URL.
- Treat devnet/Soft Net writes as real state transitions, but continue without asking for transaction confirmation when validation is already authorized.
