# Called It

**Your group chat has its own bookie now — and it never argues.**

Called It is an agentic Telegram bot that lives in a friends' group chat during the
World Cup. When someone talks big — *"Mbappé scores twice today"* — the bot prices the
claim off live TxLINE odds on the spot, a friend taps **Make him prove it**, and the
group piles onto either side with Rep (points — never money). The bot narrates the
match, locks calls during VAR checks, settles the moment the deciding stat is confirmed
in the feed, and posts a receipt — team-stat claims upgrade to **Chain-proven ✓** via a
TxLINE Merkle proof verified against the Solana-published root, viewable by anyone in a
browser with no wallet and no login.

Built for the [Superteam World Cup Hackathon](https://superteam.fun/earn/hackathon/world-cup)
(Consumer & Fan Experiences track), powered by [TxLINE](https://txline.txodds.com) on
**Solana devnet**.

## How it works

```
"Messi scores 2 today"          ← claim in normal chat
        │  bot detects it, prices it: "Data says 9% — spicy"
        ▼
[Make him prove it]             ← a FRIEND mints the market, not the bot
        │  ambiguous? one question: "In 90, or advancing?"
        │  unprovable as stated? counter-offer: "Book it Oracle-resolved,
        │  or upgrade to 'Argentina scores 2+' Chain-proven"
        ▼
[That's my shout]               ← claimer locks the terms
        ▼
Back ×10.5 / Doubt ×1.1         ← one-tap Rep positions, price locked per tap
        ▼
⚠ VAR check — calls locked      ← live freezes, price swings, goal alerts
        ▼
CALLED IT ✓ receipt             ← settled seconds after the stat confirms,
                                  Chain-proven badge flips green in the browser
```

## Monorepo

```
apps/
  engine/          one long-running Node process: grammY bot + TxLINE SSE ingest
                   + settlement + proofs + cron (Railway/Fly/any VM)
  web/             Next.js public receipt pages + leaderboard (Vercel), no auth
packages/
  market-engine/   PURE deterministic core: claim compiler, pricing, settlement
                   state machine — the most-tested code in the repo
  txline/          typed TxLINE client: auth, SSE w/ resume, asOf replay, proofs
  agent/           Claude integration: prefilter → classify → parse → persona
  db/              Supabase schema (migrations/) + typed data façade
  solana/          txoracle client (Token-2022 subscribe, validate_stat) +
                   isomorphic Merkle verify (runs in the browser too)
scripts/
  bootstrap-txline.ts   one-shot TxLINE devnet activation (prints your env values)
```

## Go-live runbook (~20 minutes of clicking)

Prereqs: Node ≥ 22, pnpm 10.

1. **Install & verify**
   ```bash
   pnpm install
   pnpm typecheck && pnpm test
   ```
2. **Telegram bot** — talk to [@BotFather](https://t.me/BotFather): `/newbot`, name it,
   copy the token into `TELEGRAM_BOT_TOKEN`. Leave privacy mode ON (default). To enable
   always-on claim detection in a group, **promote the bot to group admin** — that's the
   per-group consent lever. Without admin, the reply-trigger (`/bookit` or @mention)
   works everywhere.
3. **Supabase** — create a free project at supabase.com, open the SQL editor, paste and
   run `packages/db/migrations/0001_init.sql`. Copy the project URL, `service_role` key
   (engine) and `anon` key (web) into `.env`.
4. **GLM (Z.ai)** — create an API key at [z.ai](https://z.ai) → `GLM_API_KEY`. The
   agent drives GLM through its Anthropic-compatible endpoint (`GLM_BASE_URL`,
   default `https://api.z.ai/api/anthropic`).
5. **Solana devnet wallet** — any devnet keypair (`solana-keygen new`), base58 secret
   into `SOLANA_KEYPAIR_B58`. The bootstrap script airdrops devnet SOL itself.
6. **TxLINE activation** (devnet, free World Cup tier):
   ```bash
   cp .env.example .env   # fill the values from steps 2-5 first
   pnpm bootstrap:txline  # guest auth → on-chain subscribe → activate
   ```
   Paste the printed `TXLINE_GUEST_JWT` / `TXLINE_API_TOKEN` into `.env`.
7. **Run**
   ```bash
   # Next.js reads env from the app dir, not the repo root — copy the public
   # values through first (the service_role key must NOT go in this file):
   grep '^NEXT_PUBLIC_' .env > apps/web/.env.local

   pnpm --filter @calledit/engine dev   # the bot + ingest + settlement
   pnpm --filter @calledit/web dev      # http://localhost:3000
   ```
8. **Play** — add the bot to a group, promote it to admin, type
   *"France score 2+ today, easy"*, and take the other side.
   No live match right now? `/replay <fixtureId>` re-runs a real finished match
   through the identical pipeline at speed.

Deploy: `apps/web` → Vercel (set the `NEXT_PUBLIC_*` env vars); `apps/engine` → any
always-on Node host (Railway works: root Dockerfile-less Node service, start command
`pnpm --filter @calledit/engine start` after `pnpm install && pnpm build`). The engine
cannot run on serverless — it holds SSE + long-polling connections.

## The trust story (why Solana is here)

Every market pins the TxLINE odds record (`MessageId` + `Ts`) it was priced from — the
quoted price is provable via `/api/odds/validation`. Team-stat settlements fetch a
Merkle proof from `/api/scores/stat-validation` and verify it against the daily stat
root TxODDS publishes on-chain; the receipt page re-runs that verification **in your
browser** against a public devnet RPC. Player-level claims are honestly badged
**Oracle-resolved** (signed feed, not chain-provable) — the trust tier is always
disclosed, never overclaimed.

## Compliance by construction

Rep is non-purchasable, non-transferable, and worthless. Forfeits are non-monetary only
(the bot refuses money stakes). No wallets, tokens, fees, or accounts for players or
judges. No FIFA marks. No TxLINE data is stored in or served from this repo — replay
mode re-fetches point-in-time snapshots with the operator's own credentials.

## TxLINE endpoints used

`POST /auth/guest/start` · `POST /api/token/activate` · `GET /api/fixtures/snapshot` ·
`GET /api/scores/snapshot/{fixtureId}` (+ `asOf` replay) · `GET /api/scores/stream` ·
`GET /api/odds/snapshot/{fixtureId}` (+ `asOf`) · `GET /api/odds/stream` ·
`GET /api/scores/stat-validation` · `GET /api/odds/validation`

---
Product docs: [`docs/PRD-called-it-mvp.md`](docs/PRD-called-it-mvp.md) ·
concept: [`docs/concept-brainstorm-2026-07-02.md`](docs/concept-brainstorm-2026-07-02.md) ·
hackathon research: [`reference/`](reference/)
