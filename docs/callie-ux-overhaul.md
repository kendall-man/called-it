# Callie UX Overhaul — Poke-grade agent UX (2026-07-18)

Goal: make @callit_testing_bot feel like poke.com — instant presence, zero group clutter,
in-group signing, visible background progress — without touching escrow, settlement, or
signing correctness. Everything here is presentation over existing durable state.

Grounding: full-surface audit of `apps/engine/src/bot`, `apps/engine/src/escrow`,
`apps/concierge`, `apps/web`, plus Telegram Bot API 10.2 and eve 0.22.4 capability research
(see git history of this doc's branch for the research artifacts).

## Design principles (translated from Poke)

1. One voice, one surface. The market card is the market's single group surface; it is
   edited, never re-posted. New messages only for genuinely new events.
2. Narrate by not narrating. Background work surfaces as reactions, typing indicators,
   and in-place edits — never "processing..." messages.
3. Silence is the default. Every candidate group message must justify interrupting
   N humans; otherwise it becomes a card edit, a reaction, or nothing.
4. Money feedback must be unmissable. Failures use modal alerts and DMs, follow the
   three-part pattern (what happened / whether SOL moved / one next action).
5. The chat is the product. Leaving Telegram is allowed only for signing (Mini App)
   and the settlement receipt.

## What ships

### A. Presence (engine bot)

- 👀 reaction on the claim message the moment detection commits to parsing
  (before any LLM call), via `setMessageReaction`. 🎯 on the original claim message
  when the caller's claim settles in their favour. Best-effort raw API calls, never throw.
  This also makes the existing `/settings` "React only" mode honest.
- `sendChatAction('typing')` while parse/price/mint pipeline runs in a group.
- Skeleton card: on mint start, immediately post the card shell ("Pricing this call
  off the live feed…"), persist its message id via the existing `setMarketCardMessage`,
  then EDIT it into the full offer card. Kills the up-to-60s silent escrow-provisioning
  wait. Failure states edit the same message (no new messages, no dead air).

### B. In-group signing (direct-link Mini App) — feature-flagged

Today: group tap → callback → personal DM with a `web_app` button (private-chat-only
API limit) → Mini App with a pre-minted 300s token whose real lifetime is blockhash age
(~60-90s, tx built at tap time). Two hops, dead-ends if the user never opened the DM,
expires while people fumble.

New (active only when `TELEGRAM_MINIAPP_SHORT_NAME` is set and custody is escrow):

- The offer card's two side buttons become **URL buttons** to the registered direct-link
  Mini App: `https://t.me/<bot>/<short>?startapp=p-<marketId32>-<b|d>`. Labels unchanged
  (contract: `It happens · 0.01 SOL` / `It does not · 0.01 SOL`). URL buttons work in
  groups; the param carries NO secret (market id + side only).
- New web page `/app` is the registered Mini App entry. It reads `start_param` from
  HMAC-verified initData and routes: `p-…` → position flow, otherwise → wallet.
- New web route `POST /api/position/open`: verifies initData server-side (existing
  verifier), then calls the engine to mint the placement session **at app-open time**,
  bound to the verified Telegram user. Returns the session token to the same
  position-manager flow used today. Blockhash is fetched when the user is actually
  looking at the approval — the expiry-cliff trap disappears.
- New engine route `POST /api/escrow/positions/session` (web bridge token, same scope
  as `/api/escrow/positions/accept`): resolves the wallet link, enforces group/market
  checks, calls the existing `EscrowPlacementService.create`. `wallet_required` returns
  a typed error; the Mini App then offers in-app wallet setup via the twin route
  `POST /api/wallet/open` (mints a wallet-link session from verified initData) instead
  of dead-ending into "go DM the bot".
- Idempotency: key = sha256(`miniapp:<user>:<market>:<side>:<30s bucket>`) so re-opens
  don't mint unbounded sessions.
- Legacy callback buttons keep working (old cards, flag off, non-escrow custody).
  The DM flow remains the fallback path. Engine accept-path verification is untouched —
  the session's birth changes, the cryptographic checks don't.

### C. Background progress

- Wire the existing-but-unwired `enqueueEscrowSignerCompletionDm`: when the finalized
  indexer projects a placed/activated position (private-bridge `project()` resolves the
  Telegram user id), send the signer a completion DM with the receipt link. Idempotent
  per event key; presentation only.
- Card activity line: pending escrow lots render "fair-play delay" state (the invisible
  150s anti-snipe wait) until activation projects; uses the already-written
  `escrowPlacementStatusText` vocabulary. Rides existing card-edit collapse budgets.
- Dead-letter honesty: observe `EscrowRelayerRunResult[]` (currently discarded by
  runtime-lifecycle). Terminal `position_placement` failures (`user_signature_expired`
  etc.) DM the signer "that approval lapsed — no SOL moved — tap again". All dead-letters,
  attestation quorum failures, and indexer lag alert the ops chat (rate-limited per code).
- `/status` (group, admin): compact live board — feed state, replay virtual minute,
  open markets, positions confirming, escrow runtime health — from in-process readiness
  + `supervisor.replaySnapshot()`. No secrets, aggregate only.
- Mini App stepper: replace the single "confirming" spinner with
  Submitted → Confirmed → Finalized → Active (+ fair-play countdown when pending),
  driven by fields `/api/position/status` already returns. Haptic on finalized/failed;
  auto-close back to the chat after success.
- Modal alerts (`show_alert: true`) for money-path callback failures; toasts stay for
  success acks.

### D. Callie streaming (concierge, DM surface)

- Token streaming for Callie's private-chat replies via `sendMessageDraft`
  (native "Thinking…" placeholder, throttled ≥1s), falling back silently to the
  current single-message behaviour on any API error. Implemented as a
  `message.appended` handler on the existing eve telegram channel; the final
  `message.completed` send is unchanged (drafts are ephemeral by design).

### E. Reliability

- `ESCROW_INDEXER_PAGE_SIZE` default 1 → 10 (config; shrinks finalization→card latency).
- Auto-recover paused cards: cron re-checks escrow provisioning for markets whose card
  posted with positions paused and re-edits the keyboard in when ready.
- All new Telegram calls go through the existing Poster/SendQueue budgets or are
  budget-free (reactions, chat actions, callback answers).

## Explicitly out of scope (follow-ups)

- Adopting the unwired durable telegram ingress/outbound-ownership stack wholesale.
- Group @mention conversational replies (routing policy exists, unwired; needs the
  semantic prefilter story from CONTRACTS.md).
- eve upgrade 0.22.4 → 0.25.x (worth it for HITL hardening once approval tools return).
- Bot API 10.2 ephemeral messages (best-effort delivery; revisit after the flag ships).
- Reviving the dormant Merkle proof runtime.

## Operator steps to activate in-group signing

1. DONE (2026-07-18): BotFather `/newapp` on @callit_testing_bot registered the
   Mini App — short name `app`, Web App URL `https://called-it-snowy.vercel.app/app`,
   direct link `https://t.me/callit_testing_bot/app`.
2. Ship the overhaul so `/app` exists in production (it currently 404s — the page
   is built in this branch but not yet deployed to Vercel). Verify
   `https://called-it-snowy.vercel.app/app` returns 200 before step 3.
3. THEN set `TELEGRAM_MINIAPP_SHORT_NAME=app` on the Railway engine service; redeploy.
   Do NOT set it before step 2 — the card buttons would deep-link to a 404.
4. Without the flag nothing changes — cards keep the callback→DM flow.

Note: Bot API 10.2 Mini App origin isolation auto-enables 2026-07-20; the Mini App is
single-origin (same-origin API + RPC proxy), so no action needed.
