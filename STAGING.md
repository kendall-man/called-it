# Staging Twin — test the whole product with real people, on demand

This opt-in profile runs the
real product — real Telegram group, real GLM claim parsing, real devnet-SOL money,
real settlement engine, real receipt pages — against exactly one fake: **the World Cup
itself**. `apps/mockline` impersonates the TxLINE feed API and plays authored match
scripts, so you can kick off a "live" match whenever your friends are in the chat.

```
Telegram (real, throwaway bot)          Supabase (real, THROWAWAY project)
        │                                        │
        ▼                                        ▼
   apps/engine ──── TXLINE_API_BASE ────► apps/mockline   ← the only fake
        │                (localhost:8791, scripted matches)
        ├── Solana devnet (real chain, worthless SOL)
        ├── GLM (real key — claims parse naturally)
        └── apps/web receipts (localhost:3020)
```

What stays honest in staging: pot matching, deposits/withdrawals on devnet,
idempotency, VAR freezes, settlement math — all production code paths.
What degrades: the **Chain-proven badge** (mockline's Merkle proofs are synthetic, so
receipts settle as Oracle-resolved / "verification unavailable" — the real badge only
works against real TxLINE), and scheduled live matches appear in claim search after the
engine's 15-minute fixture sync (see "Run a match").

---

## One-time setup (~15 minutes of clicking)

**1. Throwaway Telegram bot** — @BotFather:
- `/newbot` → e.g. "Callie Staging" / `@calliestaging_bot` → copy the token
- `/setprivacy` → **Disable** (the bot must see plain group messages)
- Create a fresh group with your friends, add the bot, **make it admin**.
  Admin is the switch that turns on passive claim detection: members just type
  "Mbappé scores today" and the priced offer card appears, no reply or @ needed.
  Promote it late and detection switches on within a minute of the next message
  (the engine re-checks Telegram by itself, no restart).

**2. Throwaway Supabase project** — [database.new](https://database.new):
- Create a new project (free tier). **Never reuse the live demo project.**
- SQL editor → run, in order:
  `packages/db/migrations/0001_init.sql` → `0002_wager.sql` → `0003_broker_pivot.sql`
  → `scripts/staging-seed.sql` (demo players — Mbappé, Messi & co)
- Copy from Project Settings → API: the URL, `service_role` key, and `anon` key

**3. Env** — in this worktree root:
```bash
cp .env.staging.example .env
pnpm install
pnpm staging:keys        # generates BOTH keypairs + airdrops treasury SOL
```
Fill `.env`: bot token, Supabase URL + service_role key, your GLM key, the two
keypairs from `staging:keys`. Then the web env:
```bash
# apps/web/.env.local
NEXT_PUBLIC_SUPABASE_URL=<same throwaway URL>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
NEXT_PUBLIC_SOLANA_RPC_URL=https://api.devnet.solana.com
NEXT_PUBLIC_TXORACLE_PROGRAM_ID=6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J
```

## Boot (Mode A — engine only, no tunnel, start here)

Three terminals in the worktree:
```bash
pnpm staging:mockline    # fake TxLINE on :8791, replay match pre-loaded
pnpm staging:engine      # the real engine (loads the worktree .env)
pnpm staging:web         # receipts on :3020
```
In the group: `/start`. You're live — Callie's cards, stakes, settlement, receipts
all work. (Mode A skips only the conversational @-mention layer.)

## Run a match

**Replay (instant, the flagship demo):** in the group —
```
/kickoff 9001
```
(`/replay` still works as a hidden alias; `/kickoff` is the on-camera command.)
Mockline pre-loads **the real 2026-07-14 semifinal: France 0–2 Spain (Dallas)** —
Rabiot booked 10', Digne fouls Yamal and Oyarzabal buries the 22' penalty (quick
whistle, no VAR — argue about the handball like the real French camp), Porro's
give-and-go with Olmo at 58', Cucurella denying Mbappé in the box at 90', 0–2 after
90+7. Real starting XIs on both sides. At the default 20× replay speed that's ~6
minutes. Claims to type (player claims must land in the ~30s pre-kickoff window
right after `/kickoff`; team claims work in-play too):
- *"Spain win this"* → settles YES at full time
- *"Mbappé scores today"* → the real heartbreak — settles NO
- *"Oyarzabal scores"* → settles YES at 22'
- *"over 2.5 goals"* → settles NO (it finished 0–2)

One bet per member per call: the first Back/Against tap is the position; a
second tap gets a private "you're already in" toast instead of stacking another
stake, and tapping the other side gets "pick a lane". At full time the group
gets the winners' shout: final scoreline, every settled call with who called it
and who collects what. The plain full-time line only appears if nobody bet.

`/status` posts the live board with every bettor named per side ("⚡ 0.06 SOL
backing: Dee, Sam"), and its two buttons flip that same message between the
open-calls and match views instead of posting again, so tap-happy members can't
flood the chat. A "Pulled up by X." footer names whoever refreshed it.

`/settle` (admin, hidden from the command menu) is the fast whistle, two modes:
with a match running it jumps straight to full time, so every open call settles
through the normal feed pipeline with real outcomes and the winners' shout
posts immediately. With no match running it clears the decks instead: every
in-flight call is called off and all stakes refund in full, which also releases
the "Not while calls are open in here" guard that blocks `/kickoff` when a
leftover bet is stranded. It cannot jump `/mock/schedule` live matches (those
are paced by mockline), but the clear-decks mode still works for them.

The fictional VAR-overturn script is still available for demoing goal reversals:
`curl -X POST localhost:8791/mock/finished -d '{"script":"worldcup-final","fixtureId":9002}'`
→ `/replay 9002` (France 3–1 Argentina with a discarded Álvarez goal — note its
Argentina players aren't in the seed, so stick to team claims there).

**Live match (real SSE ingest, feels like matchday):**
```bash
curl -X POST localhost:8791/mock/schedule \
  -H 'Content-Type: application/json' -d '{"inMinutes": 20, "timeScale": 10}'
```
`inMinutes: 20` lets the engine's 15-minute fixture sync pick it up hands-off
(alternatively schedule with `inMinutes: 5` and restart the engine — it syncs at
boot). At `timeScale: 10` the match runs ~11 wall-minutes. Watch progress:
`curl localhost:8791/mock/status`. Each schedule gets a fresh fixture id (9101+).

## Money (play balances — no real devnet for members)

`WAGER_STAGING_GRANT_LAMPORTS=200000000` (staging-only seam, flag-gated, never
merged): each member's **first Back/Against tap auto-credits 0.2 SOL of play
money** through the same idempotent ledger path a real deposit uses — no wallets,
no faucets, no deposits. Pot matching, escrow, and settlement run the untouched
production code on internal balances.

- Grants count toward solvency like real deposits: the treasury's 3 devnet SOL
  covers ~15 members at 0.2 each. More friends → raise the treasury or lower the
  grant, or the breaker pauses staking (`wager_insolvent` in the log).
- `/wallet`, `/deposit`, `/withdraw` still exist (production surface) but are
  unnecessary in the mock; withdrawals to a synthetic `staging-play-*` handle fail
  gracefully with a refund.

## Mode B — full product incl. Callie conversation (webhook single-ingress)

Callie's @-mention chat layer runs on eve, whose Telegram channel is **webhook-only**,
so it needs a public URL (production runs it as its own Railway service):
```bash
# 1. expose the local concierge
cloudflared tunnel --url http://localhost:3000        # note the https URL

# 2. flip the ingress in .env
TELEGRAM_INGRESS=webhook          # engine stops polling; updates arrive via API
CONCIERGE_BOT_USERNAME=calliestaging_bot
TELEGRAM_WEBHOOK_SECRET_TOKEN=<random string>

# 3. run the concierge with the worktree env (eve dev prints its webhook route)
set -a; source .env; set +a
pnpm staging:concierge

# 4. point Telegram at the tunnel
curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=<tunnel-url><eve-telegram-route>" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET_TOKEN>"
```
Restart the engine after flipping `TELEGRAM_INGRESS` (in webhook mode it refuses to
poll; the concierge forwards cards/commands/callbacks to `/api/telegram-update`).
To go back to Mode A: `deleteWebhook`, set `TELEGRAM_INGRESS=poll`, restart. See
`docs/eve-concierge-plan.md` for the deployment rationale.

## Safety rails

- This profile is **staging-only**: mockline and seed data stay disabled unless the
  staging commands and staging environment are selected explicitly.
- Never point `.env` at the live demo Supabase, the prod bot token, or the prod
  TxL wallet. The staging treasury keypair is throwaway by design.
- `.env` / `apps/web/.env.local` are git-ignored — keep secrets out of commits.
- The engine refuses to boot if `WAGER_TREASURY_KEYPAIR_B58` equals
  `SOLANA_KEYPAIR_B58` (sponsor terms) — `staging:keys` always generates a distinct pair.

## Troubleshooting

- **Claims only work via reply, /bookit or @mention** → the bot is not a group
  admin. Promote it; passive detection switches on within a minute (the engine
  re-checks Telegram on the next message, no restart needed).
- **"no price" on every claim** → mockline not running, or `TXLINE_API_BASE` not
  pointing at :8791 (odds come from the mock book).
- **`/replay 9001` says unknown fixture** → the engine hasn't synced fixtures yet;
  restart the engine (it syncs at boot) or wait for the 15-min tick.
- **Player claims don't compile** → `scripts/staging-seed.sql` not applied to the
  throwaway project.
- **Deposits never credit** → treasury unfunded (re-run `pnpm staging:keys` airdrop or
  faucet.solana.com) or the sender wallet isn't `/wallet`-linked.
