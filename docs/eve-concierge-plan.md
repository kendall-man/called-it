# Plan: the Called It concierge on eve (v1)

**Status:** proposed (2026-07-08). Grounded in eve@0.22.0 bundled docs + channel source
(installed and read directly), not memory. Deadline context: freeze 2026-07-15,
submission 2026-07-19.

## What we're building, in one line

A second, eve-powered Telegram bot — the **concierge** — that lives in the same group
as @footballcallit_bot and handles the whole betting cycle *conversationally*
("what's open?", "put me down 50 on France", "did I call it?"), with every real
action executed by the existing deterministic engine over a small authenticated API.

This is the NL-intent-layer spec (v2) *re-based onto eve*: eve natively provides the
pieces we specced by hand — the addressing spine, confirm drafts, budget buckets,
durable sessions — so the layer gets thinner and safer than our hand-rolled design.

## Why a second bot (the "feature bot"), not a port

- **eve's Telegram channel is webhook-based and addressed-gated by design**: in
  groups, only commands, @mentions, and replies-to-the-bot wake it. That is exactly
  the NL spec's addressing spine — but it also means **ambient claim detection
  cannot move to eve** (it never sees unaddressed messages). The engine keeps the
  passive-detection spine; eve owns addressed conversation.
- **One token can't serve both**: `setWebhook` (eve) kills `getUpdates`
  (engine long-poll). Two bots, two tokens, one group.
- **7 days to freeze**: additive beats rip-out. The engine — settlement, proofs,
  replay, cards — is live-proven; it doesn't move. The concierge is a new
  `apps/concierge` that can be cut loose at any moment without touching the demo
  spine. Buttons remain the demo-safe path.

## Topology

```
Telegram group
├── @footballcallit_bot   (engine, Railway, long-poll — UNCHANGED spine)
│     passive detection → nudge cards → buttons → mint → settle → prove → receipts
└── @<new>_bot            (concierge, eve on Vercel, webhook)
      addressed talk → eve agent (skills+tools) → ENGINE HTTP API → same DB, same locks
```

The concierge NEVER writes to Supabase and NEVER computes a price. Every mutation
goes through the engine's API, which reuses the exact handlers, guards, and locks
the buttons use. **LLM proposes, code disposes — now with the LLM in a separate
process.**

## Part 1 — Engine: small authenticated HTTP API (new module, `main` branch)

The engine today has no HTTP server; it gains one module (`apps/engine/src/api/`),
bound to `PORT` (Railway provides), bearer-auth'd with `ENGINE_API_TOKEN`.
Endpoints map 1:1 onto existing functions — no new business logic:

| Endpoint | Reuses | Notes |
|---|---|---|
| `GET  /api/health` | — | liveness |
| `GET  /api/groups/:chatId/snapshot` | `openMarketsForGroup`, `describeTerms`, leaderboard query | open markets w/ prices+sides, top of table |
| `GET  /api/groups/:chatId/users/:userId/wallet` | `balance`, `positionsForMarket` | Rep balance + open positions |
| `POST /api/quote` `{chatId,text}` | `proveClaim` parse→compile + `quoteSpec` | **read-only** quote: options + prices; no claim row minted |
| `POST /api/stake` `{chatId,marketId,userId,side,amount}` | `handleStake` core via `withStakeLock` | all guards: one-side, cap, balance, cutoff, positive-int |
| `GET  /api/markets/:id` | `getMarket` + settlement + proof rows | status, tier, receipt URL |
| `GET  /api/fixtures` | `fixtures` table | what's on today |

Design rules:
- The stake path is **refactored, not duplicated**: extract the critical section of
  `handleStake` into a transport-agnostic `executeStake(deps, cmd)` that both the
  callback handler and the API call — one code path, one lock (`withStakeLock`),
  one set of tests. (This is P2/P5 of the NL spec done properly.)
- Amounts are **arbitrary positive integers** validated server-side (the guard
  shipped in 5c448a9) — conversational stakes aren't preset-bound.
- **Mutating endpoints require an `idempotencyKey`** (the eve tool passes
  `ctx.callId`). eve's durable execution *re-runs interrupted steps*, so a stake
  request can legitimately arrive twice; the engine dedupes via the ledger's
  existing `idempotency_key` before inserting a position. Single-writer stays
  intact: the in-memory locks only work because the Railway engine is the ONLY
  process that mutates — the concierge never touches the DB.
- The engine posts its own group-chat side effects (card updates) exactly as if a
  button was tapped — so the group sees one consistent surface.

## Part 2 — The eve app: `apps/concierge`

```
apps/concierge/
├── package.json            (eve, ai, zod; engines.node 24.x)
├── agent/
│   ├── agent.ts             defineAgent: model + limits + compaction
│   ├── instructions.md      identity, voice, hard rules
│   ├── channels/telegram.ts telegramChannel({ botUsername })
│   ├── tools/
│   │   ├── get_group_snapshot.ts   → GET snapshot
│   │   ├── get_my_wallet.ts        → GET wallet (identity from session, see below)
│   │   ├── quote_claim.ts          → POST /api/quote
│   │   ├── place_stake.ts          → POST /api/stake   [approval: policy]
│   │   ├── get_market_status.ts    → GET market (receipt link, tier)
│   │   └── list_todays_matches.ts  → GET fixtures
│   ├── skills/
│   │   ├── house-rules.md          how markets/Rep/tiers/caps work; one-side rule
│   │   ├── placing-bets.md         quote-then-stake procedure; when to confirm
│   │   ├── voice.md                game-show register; the deny-list (no bookie
│   │   │                            vocabulary, no odds notation, no currency)
│   │   ├── receipts-and-proof.md   explaining Chain-proven vs Oracle-resolved
│   │   └── replay-demo.md          driving a demo replay conversationally
│   └── lib/engine-api.ts     typed fetch client (bearer ENGINE_API_TOKEN)
```

Key mechanics (all verified against eve docs/source):

- **Trusted identity (the N4 invariant).** The Telegram channel builds session auth
  from the *webhook payload*: `principalId = telegram:{chatId}:{userId}`,
  attributes `{chat_id, user_id, username}`. Tools read
  `ctx.session.auth.current.attributes` — **never** a model-supplied user id. A
  prompt-injected "stake as @rival" is structurally impossible.
- **Confirmation = approval gate.** `place_stake` uses an `approval` policy →
  eve renders a native **inline-keyboard approve/deny** in Telegram and durably
  parks until answered. Policy: small stake with clean parse → `"not-applicable"`
  (no ceremony); large-relative-to-balance or first stake of the session →
  `"user-approval"`. Cross-user: approval is answered in the same session —
  the staker's own confirm.
- **Budget (R1).** `defineAgent({ limits })` caps tokens per session natively.
- **Voice.** Instructions + `voice.md` skill carry the deny-list and register.
  (The deterministic deny-list stays enforceable engine-side for card copy; the
  concierge's copy is model-authored by design — same as Poke.)
- **Model.** GLM direct — **VALIDATED 2026-07-08**:
  `createAnthropic({ baseURL: GLM_BASE_URL + '/v1' })('glm-4.6')` returns clean
  completions through the AI SDK. Keeps the exact cost profile of today's engine.
  Fallback (one-line swap): `anthropic/claude-sonnet-5` via Vercel AI Gateway.
- **Group privacy mode**: BotFather `/setprivacy` → **Disable** for the concierge
  (Telegram doesn't deliver plain @mentions to privacy-on bots; eve's own gating
  drops unaddressed messages anyway).
- **Proactive nudges (v2, optional):** eve `schedules/` + `receive(telegram, ...)`
  can push "your market settled — you called it" into the group without an inbound
  message.

## What does NOT change

- `packages/agent` (GLM classify/parse/persona) — the engine's ambient path keeps it.
- The button flow, cards, settlement, proofs, replay, web receipts.
- The wager branch (SOL) — untouched; SOL tools are a later, branch-only addition.
- No code deleted anywhere this close to freeze. Purely additive.

## Phases & gates

| # | What | Where | Gate |
|---|---|---|---|
| 0 | Restore Railway engine (bot is currently DOWN); user creates the new bot via @BotFather → hands me token + username | you + me | bot live again |
| 1 | Engine API module + `executeStake` refactor + tests | `main` | engine tests green; deployed to Railway |
| 2 | Scaffold `apps/concierge`; instructions/skills/tools; local `eve dev` against the Railway API; model choice validated | `main` | conversational quote+stake works locally |
| 3 | Deploy to Vercel (separate project, root `apps/concierge`); `setWebhook` with secret; live group test | prod | talk-to-bet works in your group |
| 4 | Polish: approval policy tuning, voice pass, `/help` skill; optional settle-notification schedule | prod | demo-ready beat |

Estimated effort: Phase 1 ≈ half a day; Phase 2 ≈ a day; Phase 3 ≈ hours.

## Risks (named, owned)

1. **eve is 3 weeks old (v0.22.0, released 2026-07-07).** Sharp edges likely.
   Mitigation: concierge is severable; demo never depends on it; buttons stay.
2. ~~GLM-via-AI-SDK unvalidated~~ — **retired**: validated with a live call
   (2026-07-08); GLM runs through `@ai-sdk/anthropic` with `baseURL + /v1`.
   Remaining sliver: GLM *tool-calling* inside the eve loop — smoke-tested as the
   first step of Phase 2 (gateway Sonnet is the one-line fallback).
3. **Node 24 requirement** for the eve app (repo engines is `>=22`). The
   concierge pins its own engines + Vercel project Node setting.
4. **Two bots in one group** could double-speak. Mitigation: concierge never posts
   cards; engine never answers free text. Disjoint surfaces by construction.
5. **Judge optics**: an agent you talk to that places bets = the "poke for bets"
   wow — but the demo script keeps it as the *garnish beat*, with the proven
   settlement loop as the spine.

## Verification-pass findings folded in (adversarial gap critic, 2026-07-08)

- **Deploy-first spike**: eve on Vercel uses Workflow + Sandbox infrastructure;
  plan-gating on this account is unverified, and a failed sandbox prewarm fails
  the build. Phase 3 therefore STARTS by deploying the bare scaffold before any
  real code depends on the hosting choice. Fallback (documented in eve's own
  deployment guide): `eve build && eve start` as a plain Node service — i.e. a
  second Railway service — with zero feature loss.
- **Zero workspace deps in the concierge (v1)**: eve's Nitro build bundling
  `workspace:*` packages is unverified, so `apps/concierge` imports NO
  `@calledit/*` package. Tools call the engine API; voice/deny-list rules live in
  markdown. The pnpm-monorepo risk is avoided rather than mitigated.
- **HITL responder identity**: whether eve restricts who may answer an approval
  keyboard is unverified. Verify in the two-phone group test; fallback is our own
  inline keyboard via `onCallbackQuery` → engine API (mirrors today's
  callbacks.ts guards exactly).
- **Never depend on session memory for facts**: group sessions are per-message /
  per-reply-thread and their retention window is unverified. Every tool
  re-hydrates from the engine API by ids; a stale session can degrade UX, never
  correctness.
- **Local dev loop**: Telegram is webhook-only (verified in adapter source — no
  polling mode). Dev via `cloudflared tunnel` → `setWebhook` to the tunnel, or
  `eve dev https://<preview-url>` against a deployed preview.
- **Future option (verified in source)**: `onMessage` can fully override the
  group gating — passive listening on eve IS possible later; and
  `events["message.completed"]` is overridable — a deterministic deny-list check
  on outgoing concierge text is available if voice drift shows up.

## Open items for the user

- Create the bot: @BotFather → `/newbot` → name it (suggestion: "Callie —
  Called It concierge", username like `@callieconcierge_bot`) → send me the token.
- Approve the Railway restore (currently blocked by permissions).
- Model call: GLM direct (validated, cost-consistent — default) vs gateway Sonnet —
  GLM unless you say otherwise.
