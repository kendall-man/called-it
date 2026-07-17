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

## Stop rules

- One restart per failed component, then diagnose.
- Tunnel startup has a bounded deadline.
- Never run polling while a Telegram webhook is set.
- Never reuse a dead `trycloudflare.com` URL.
- Treat devnet/Soft Net writes as real state transitions, but continue without asking for transaction confirmation when validation is already authorized.
