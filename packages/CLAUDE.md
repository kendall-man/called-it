# packages/, shared libraries (one direction: apps depend on these, never the reverse)

None of these read env vars except `agent` (`GLM_API_KEY`, `GLM_BASE_URL`, and the legacy
`ANTHROPIC_API_KEY` fallback). db, solana, and txline take credentials as constructor or
function arguments. All are ESM, built with tsc, tested with vitest, no network in CI.

## market-engine, the pure core

`compileClaim` (LLM parse to validated MarketSpec, "LLM proposes, code disposes"),
`priceSpec` (odds snapshot to locked quote), `reduceMarket` (feed events to market
lifecycle plus effects), and `checkDebounce`. No I/O, no clocks, no env: the engine
persists state and applies effects. All shared domain unions and constants (`TUNABLES`,
`CLAIM_TYPES`, phases) come from here. Never redeclare them elsewhere.

Reducer invariants that bite:
- One monotonic `scratch.lastSeq` cursor per market, for score-stream events only.
  Odds-stream events (`odds_suspension`) carry epoch-ms seqs from the Ts field and must
  BYPASS that cursor (see reduce.ts). Running one through it blinds the market to every
  later score event and wedges it frozen with stakes escrowed.
- Freeze reasons: `var` and `possible_event` block settlement ("doubt"), while
  `odds_suspension` and `cutoff` freeze staking but let settlement proceed.
- The delay-snipe guard voids `pending` positions placed after a price-moving event.
  For live markets the reference is event `tsMs` (on-pitch time). For replays it is
  `receivedAtMs` (emission time), gated on `MarketState.isReplay`, because replay `tsMs`
  is the original historical timeline (hours or days in the past) and every in-play tap
  would otherwise read as a snipe.
- Settlement is debounced (`SETTLEMENT_DEBOUNCE_MS`). A hold signal inside the window
  cancels the candidate and re-freezes.

## txline, feed client plus event sources

`TxlineClient` (guest JWT plus api token headers on every call), `LiveSource` (SSE with
Last-Event-ID cursor resume, a gap-fill hook that fires only on reconnect, a 90s heartbeat
watchdog), and `ReplaySource` (virtual clock over `asOf` snapshots, 30s virtual ticks,
10min pre-kickoff lead, 4h hard stop, re-fetching with the runner's own creds so no
payloads are recorded). Normalizers are defensive: unknown shapes log and skip, never
throw. Half-time market suspensions must not freeze full-match markets (the
`isFullMatchPeriod` guard in both sources). Never commit real TxLINE feed data; fixtures
are synthesized (`test-fixtures.ts`).

## agent, the three LLM touchpoints

`prefilter` (pure regex plus entity dictionary, kills over 95% of messages pre-LLM),
`classifyMessage` (glm-4.5-air), `parseClaim` (glm-4.6, forced tool-use rounds against
OUR fixture and player search executors, so the model cannot invent entity ids), and
`persona` (deterministic templates plus optional garnish, with a deny-list that bans odds
notation but allows bet, stake, and against post-pivot). The golden-set harness runs
scripted clients in CI, and live model calls happen only with `AGENT_LIVE=1`. Keep
`goldenSet.ts` at 50 or more fixtures including slang, typos, and non-claims
(test-asserted).

## db, Supabase facade plus migrations

`createEngineDb` and `createWagerDb` (service-role, and the web never touches these).
Migrations are additive and ordered: `0001_init` (core, including the now-dormant Rep
tables), `0002_wager` (SOL tables, RLS on, zero anon policies), `0003_broker_pivot`
(wager_stake v2, which MUST be applied before deploying the pivoted engine, and which
drops the old 8-arg overload). bigint crosses PostgREST as a JS double, so every crossing
goes through `assertSafeInteger`. `WAGER_MULT_SCALE=1000` must equal the SQL constant and
the engine's `MULT_SCALE` (parity-tested). Idempotency keys make every money write
upsert-ignore. Never add a write without one.

## solana, chain I/O plus isomorphic verify

Two entry points: `.` (node: `loadWallet`, txoracle subscribe and validate builders,
wager `buildSolTransfer`, `broadcastRawTx`, `getSigStatus`, `fetchIncomingTransfers`) and
`./verify` (isomorphic: no node imports, no @solana/web3.js, because the web bundles it via
the `solana-verify-bridge` alias). The TxL mint is Token-2022: derive ATAs with
`TOKEN_2022_PROGRAM_ID` or you get the wrong address. `@coral-xyz/anchor` must be
default-imported and destructured (a named `BN` import breaks native ESM in prod). The
deposit scanner recognizes system-program transfers only, credited per `(tx_sig,
ix_index)`. Test keys are invented (`fixtures/keys.ts`), so no real chain data lives in the
repo. The daily roots PDA holds 288 five-minute slots, so use `fetchOnchainRoots` (plural)
and pick by `minuteOfDay`.
