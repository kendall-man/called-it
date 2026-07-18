# Rumble bot cutover + Mini App registration — operator handoff

**Status:** ready to execute · **Written:** 2026-07-19 · **Audience:** an agent or operator with Telegram/BotFather access

## Why this handoff exists

The product and agent were renamed to **Rumble** (from "Called It" / "Callie"). The code
rename is already merged to `main` (commit `feat(brand): rename product and agent to
Rumble`). A brand-new Telegram bot **@getrumble_bot** has been created to carry the new
identity. Its profile (name, bio, description) is already set via the Bot API.

Two setup steps require **BotFather**, which can only be driven by a human or an agent with
interactive Telegram access (the authoring agent could not type into Telegram Web/Desktop):

1. **Register the direct-link Mini App** (short name `app`) so in-group signing uses the
   `t.me/getrumble_bot/app?startapp=...` deep link.
2. **Disable privacy mode** so Rumble can passively read group messages for claim detection.

After BotFather, the **infra cutover** (swap the bot token across three services, redeploy,
re-point the webhook) can be done by anyone with the Railway + Vercel CLIs authenticated.

> **Note on the Mini App and the fallback.** In-group signing has a built-in fallback: if
> `TELEGRAM_MINIAPP_SHORT_NAME` is left unset, the signing button becomes a callback that
> DMs the user a `web_app` "Review and sign" button (no BotFather registration needed). The
> preferred, cleaner UX is the registered direct-link Mini App, which is why this doc walks
> through registering it. See `apps/engine/src/bot/stake-step-keyboards.ts` and
> `apps/engine/src/bot/keyboards.ts` (`miniAppPositionUrl`) for the exact branch.

## Identities and constants

| Thing | Value |
|---|---|
| New bot username | `@getrumble_bot` |
| New bot id | `8901500483` |
| New bot token | `<PASTE @getrumble_bot BOT TOKEN — kept out of this file; get it from the owner>` |
| Old bot (being retired) | `@callit_testing_bot` |
| Web base URL | `https://called-it-snowy.vercel.app` |
| Mini App URL (for `/newapp`) | `https://called-it-snowy.vercel.app/app` |
| Mini App short name | `app` |
| Mini App photo (640×360) | `~/Desktop/rumble-app.png` |
| Concierge webhook URL | `https://concierge-production-01e3.up.railway.app/eve/v1/telegram` |
| Webhook allowed_updates | `["message","callback_query","my_chat_member"]` |
| Webhook secret | value of `TELEGRAM_WEBHOOK_SECRET_TOKEN` (keep the current value; shared with concierge) |
| Railway services | `engine`, `concierge` |
| Web host | Vercel (deploy from repo root) |

## Prerequisites

- Interactive Telegram access (phone app, Telegram Desktop, or a browser you can type into)
  logged into an account that can talk to **@BotFather**.
- `railway` CLI authenticated to the `called-it-engine` project (`railway whoami`).
- `vercel` CLI authenticated to the web project (`vercel whoami`).
- The `@getrumble_bot` token (above).
- Do this at a quiet moment: **the switch retires @callit_testing_bot**. Every group must
  re-add @getrumble_bot and promote it to admin, and every user must `/start` it in DM
  before it can send them a signing link. Old cards posted by the old bot go inert.

---

## Part A — BotFather (interactive, one-time)

### A1. Register the Mini App

Message **@BotFather**:

```
/newapp
```

Then answer the prompts:

- **Select bot:** `@getrumble_bot`
- **Title:** `Rumble`
- **Description:** `Sign your position from the group chat`
- **Photo:** upload `~/Desktop/rumble-app.png` (already 640×360)
- **GIF demo:** send `/empty`
- **Web App URL:** `https://called-it-snowy.vercel.app/app`
- **Short name:** `app`  ← must be exactly `app`; it is what the engine's deep links target

Verify the link opens: `https://t.me/getrumble_bot/app` should launch the web app.

### A2. Disable privacy mode

```
/setprivacy
```

- **Select bot:** `@getrumble_bot`
- Tap **Disable**

(Leaving privacy enabled still lets Rumble answer @mentions, `/bookit`, and replies; it only
blocks passive detection of undirected claims.)

---

## Part B — Infra cutover (CLI)

The bot token lives in `TELEGRAM_BOT_TOKEN` on all three services. `ENGINE_TELEGRAM_TOKEN`
is a **different** value (an engine-API bearer) — **do not touch it**.

Set `TOKEN` in your shell first (do not commit it anywhere):

```bash
export NEWTOKEN='<PASTE @getrumble_bot BOT TOKEN>'
```

### B1. Railway — engine

```bash
railway variables --service engine \
  --set "TELEGRAM_BOT_TOKEN=$NEWTOKEN" \
  --set "TELEGRAM_BOT_USERNAME=getrumble_bot" \
  --set "TELEGRAM_MINIAPP_SHORT_NAME=app"
# If you SKIPPED Part A1, use TELEGRAM_MINIAPP_SHORT_NAME="" instead (enables the DM fallback).
railway up --service engine        # deploys latest main (Rumble copy) with the new vars
```

### B2. Railway — concierge

```bash
railway variables --service concierge \
  --set "TELEGRAM_BOT_TOKEN=$NEWTOKEN" \
  --set "TELEGRAM_BOT_USERNAME=getrumble_bot"
railway up --service concierge
```

### B3. Vercel — web

The web reads `TELEGRAM_BOT_TOKEN` to verify Telegram Mini App `initData` (the HMAC is
keyed on the bot token), and `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` for deep links. Both must
change or Mini App signing verification fails.

```bash
# From repo root. Remove then re-add each var, then deploy.
printf '%s' "$NEWTOKEN"     | vercel env add TELEGRAM_BOT_TOKEN production
printf 'getrumble_bot'      | vercel env add NEXT_PUBLIC_TELEGRAM_BOT_USERNAME production
# (vercel env rm <NAME> production --yes first if it already exists)
vercel deploy --prod
```

### B4. Webhook

Point the **new** bot's webhook at the concierge front door and retire the old bot's.

```bash
# New bot: set webhook
curl -s "https://api.telegram.org/bot$NEWTOKEN/setWebhook" \
  -H 'content-type: application/json' \
  -d '{
    "url":"https://concierge-production-01e3.up.railway.app/eve/v1/telegram",
    "secret_token":"<value of TELEGRAM_WEBHOOK_SECRET_TOKEN>",
    "allowed_updates":["message","callback_query","my_chat_member"],
    "drop_pending_updates":true
  }'

# Old bot (@callit_testing_bot): remove its webhook so it stops receiving
curl -s "https://api.telegram.org/bot<OLD_BOT_TOKEN>/deleteWebhook" \
  -d 'drop_pending_updates=true'
```

Get `TELEGRAM_WEBHOOK_SECRET_TOKEN` and the old bot token from Railway
(`railway variables --service concierge --kv | grep ...`) without printing them into logs.

---

## Part C — Verification

```bash
# Webhook is set, no errors, on the new bot
curl -s "https://api.telegram.org/bot$NEWTOKEN/getWebhookInfo" | python3 -m json.tool

# Services healthy
curl -s https://<engine-domain>/api/health
curl -s https://called-it-snowy.vercel.app/ -o /dev/null -w '%{http_code}\n'
```

Then a live smoke test in a test group:

1. Add **@getrumble_bot** to the group; promote to admin (manage messages).
2. `/start` it in a private chat once (so it can DM you the signing link).
3. `/replay <fixtureId>` (admin) to drive a demo match, or make a live football call.
4. Confirm one offer card posts, tap a side, dial the stepper, tap **Review and sign**.
5. If Part A1 was done: the button opens `t.me/getrumble_bot/app`. If skipped: the bot DMs
   you a "Review and sign" `web_app` button. Either way the position must finalize on-chain
   and the group card updates only after finalization.
6. Confirm copy reads **Rumble** throughout (bot messages, receipts, web).

---

## Part D — Rollback

The old bot token is still valid until you delete it, so rollback is fast:

```bash
# Restore old token + username on all three services, redeploy, restore old webhook.
railway variables --service engine   --set "TELEGRAM_BOT_TOKEN=<OLD>" --set "TELEGRAM_BOT_USERNAME=callit_testing_bot"
railway variables --service concierge --set "TELEGRAM_BOT_TOKEN=<OLD>" --set "TELEGRAM_BOT_USERNAME=callit_testing_bot"
railway up --service engine && railway up --service concierge
# Vercel: restore TELEGRAM_BOT_TOKEN + NEXT_PUBLIC_TELEGRAM_BOT_USERNAME, vercel deploy --prod
curl -s "https://api.telegram.org/bot<OLD>/setWebhook" -H 'content-type: application/json' \
  -d '{"url":"https://concierge-production-01e3.up.railway.app/eve/v1/telegram","secret_token":"<secret>","allowed_updates":["message","callback_query","my_chat_member"]}'
```

Keep both bots' tokens until the smoke test passes.

---

## Reference — key files

- `apps/engine/src/bot/keyboards.ts` — `miniAppPositionUrl` (direct-link builder; returns
  `null` when the short name is unset, triggering the fallback).
- `apps/engine/src/bot/stake-step-keyboards.ts` — stepper action row; the `signUrl: null`
  branch is the DM-callback fallback.
- `apps/engine/src/bot/callbacks.ts` (~line 452) — issues the private signing link as a
  `web_app` inline button in a DM.
- `apps/engine/src/env.ts` — `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`,
  `TELEGRAM_MINIAPP_SHORT_NAME` schema.
- `apps/web/lib/miniapp-server.ts` + `apps/web/lib/env.ts` — `initData` HMAC verification
  keyed on `TELEGRAM_BOT_TOKEN`.
- `scripts/production-telegram-webhook.mjs` — reference for webhook wiring / `pnpm production:webhook`.

## What was already done by the authoring agent (do not repeat)

- `@getrumble_bot` profile via Bot API: `setMyName` → `Rumble`, `setMyShortDescription`,
  `setMyDescription`. (Re-runnable if you want to tweak copy.)
- The Rumble code rename is merged to `main` and CI is green.
- The Mini App photo is staged at `~/Desktop/rumble-app.png`.
