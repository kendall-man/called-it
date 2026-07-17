# apps/engine, the single long-running process

One Node process, one DB writer. Everything here hangs off `Deps` (`src/ports.ts`).
`src/wiring.ts` is the only file that imports sibling packages. Modules never import
each other's internals; they meet at ports.

## Boot contract (src/main.ts)

- `loadDotEnv()` walks up to the repo-root `.env`. Values already in the process env
  win, which is how deploys and test overrides inject config.
- `loadEnv()` (src/env.ts) zod-validates. Boot throws if `WAGER_MODE_ENABLED !== 'true'`,
  or if `WAGER_TREASURY_KEYPAIR_B58` is missing or equal to `SOLANA_KEYPAIR_B58`. SOL is
  the only currency, so an unwired wager module would mint nothing silently.
- `TELEGRAM_INGRESS=poll` uses the grammY runner (long polling). `webhook` means no
  polling: the engine calls `bot.init()` and consumes updates POSTed to
  `/api/telegram-update` (requires `ENGINE_API_TOKEN`). In webhook mode the concierge
  owns the actual Telegram webhook and forwards non-conversational updates. Never run a
  poller while a webhook is set, because Telegram returns 409.

## Module map

| Area | Files | What matters |
|---|---|---|
| Bot assembly | `bot/bot.ts` | middleware order: command-upsert, commands, callbacks, detection. `my_chat_member` flips `groups.is_admin` (the consent lever for passive detection) |
| Commands | `bot/commands.ts` | `/start /help /settings /replay /bookit`. The wager module adds `/wallet /deposit /withdraw` via the `registerCommands` seam |
| Buttons | `bot/callbackData.ts` | 64-byte codec: `st:<marketId>:b|d:<presetIdx>` stakes, `pv:/op:/nx:` claim taps. Every tap resolves against DB rows, with zero in-memory conversation state |
| Callbacks | `bot/callbacks.ts` | per-claim in-process `Set` mutex (there is no unique index on `markets.claim_id`, so the one-market-per-claim guard lives inside this lock). Stale or forged callback ids are answered best-effort and swallowed |
| Detection | `bot/detection.ts` | passive path gated on `group.is_admin` AND chattiness AND `prefilter` AND `LlmBudget`. Trigger paths (@mention, `/bookit` reply, "book it" reply) bypass the classifier |
| Claim to market | `pipeline/offer.ts`, `pipeline/claims.ts` | detect, parse, price, then mint ONE offer card, with no confirm ceremony. The mint-time quote LOCKS the settlement ratio, so never mint on a failed or degenerate quote. Replay groups pin the parse to the replayed fixture |
| Settlement | `settle/settler.ts` plus the `packages/market-engine` reducer | feed events, `insertFeedEvent` dedupe on `(fixture_id, seq)`, pure `reduceMarket`, effects applied here. Passes `row.is_replay` into the reducer state |
| Ingest | `ingest/supervisor.ts` | one LiveSource per live fixture, one replay per group. `startReplay` resets fixture state (clears `feed_events`, rewinds `last_seq`) so re-replays actually emit |
| Crons | `cron/index.ts` | 15-min fixture sync (also at boot), ingest refresh, settle debounce tick, claim TTL expiry, zero-bet market void sweep, unposted-receipt sweeper |
| API | `api/server.ts` | node:http, bearer-auth (`ENGINE_API_TOKEN`, hashed timing-safe compare). `/api/health` is open. `/api/stake` is the one mutating route (client idempotency key required). `/api/telegram-update` exists only in webhook ingress |
| Wager | `wager/` | see below |

## Wager module (`src/wager/`)

Custodial devnet SOL. `wiring.ts` builds it only when both env gates pass (via a dynamic
import, so flag-off deploys load zero wager bytes). Every seam null-checks.

- **Commands**: `/wallet [pubkey]` links (first-to-link wins, and auto-credits prior
  orphan deposits), `/deposit` prints the treasury address, `/withdraw <sol|all>`.
  A `bot.on('message:text')` middleware in `bot/bot.ts` upserts the user and group for
  any group command before its handler runs, so a first-touch `/wallet` cannot hit the
  `wager_wallet_links` users FK. If you add wager commands, that middleware covers them.
- **Stakes** (`stake.ts`): gates are linked wallet, then persisted circuit breaker, then
  the `wager_stake` RPC (balance debit plus advisory lock per user, idempotency-key
  dedupe). Pre-kickoff taps are `active`, in-play taps `pending` (the delay-snipe
  window). The doubt multiplier formula is mirrored from `pipeline/claims.ts`, and
  parity is test-asserted, so keep both in sync.
- **Deposits** (`deposits.ts`): 30s poll of treasury incoming transfers at `finalized`
  commitment, keyed `(tx_sig, ix_index)`, min 0.001 SOL (dust is stored, never
  credited). Unlinked senders become orphans, swept on `/wallet` link. Notifications go
  to `last_wager_group_id`, never DMs (the bot cannot open one).
- **Withdrawals** (`withdrawals.ts`): outbox state machine. Signed bytes are persisted
  BEFORE broadcast. Re-sign only when the status lookup (`searchTransactionHistory:true`)
  proves not-landed AND the blockhash expired. The refund credit posts before the
  `failed` flip. Min 0.01 SOL, fees house-absorbed.
- **Money numbers** live in `wager/constants.ts` (presets 0.01/0.05/0.1 SOL, per-market
  cap 0.1, fee buffer) and are bigint lamports everywhere. Idempotency keys in
  `WAGER_KEYS` are the single source, and the SQL RPC mirrors them.
- **Solvency** (`solvency.ts`): escrow-inclusive coverage check. Pauses staking via the
  persisted breaker with a `solvency:`-prefixed reason, so auto-recovery never clears a
  manual pause.

## Gotchas observed live

- The reducer keeps one monotonic `scratch.lastSeq` cursor for score-stream events.
  Odds-stream `odds_suspension` events carry epoch-ms seqs (a different sequence space),
  so they bypass that cursor. If they did not, one suspension would mark every later
  score event stale and wedge the market frozen with stakes escrowed (a bug found and
  fixed during the 2026-07-16 wallet E2E).
- `poster.post` now sends replies with `allow_sending_without_reply: true`, so a deleted
  source message cannot make the whole offer-card send fail.
- `BOT_COMMANDS` (bot/bot.ts) is what `setMyCommands` registers. Keep it in sync with the
  real handler surface (it drifted post-pivot, listing `/table` and omitting the wager
  commands).
- Cron "locks" are in-process Sets (`wiring.ts`), not DB advisory locks. Safe only
  because the engine is a single process. Do not scale horizontally.
- The send queue caps at 18 messages per minute per chat, and card edits collapse. Never
  call `bot.api.sendMessage` directly. Everything goes through `Poster`.
- Tests: `wager/fakes.ts` has the module test doubles, and `pot.ts` is property-tested.
  Run `pnpm --filter @calledit/engine exec vitest run src/wager` after touching money
  paths.
