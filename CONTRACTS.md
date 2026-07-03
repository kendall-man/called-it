# Package Contracts (fleet coordination — delete after MVP integration)

Ground rules for every builder:
- TypeScript strict, ESM (`type: module`), Node 22+. `pnpm` workspace already scaffolded.
- Import shared domain types ONLY from `@calledit/market-engine` (`src/types.ts`,
  `src/constants.ts` — already written, do not modify without noting it).
- No I/O in `packages/market-engine`. No TxLINE payloads committed anywhere.
- Env vars: read exactly the names in `.env.example`.
- Each package owns ONLY its own directory. Do not touch other packages.
- Consumer copy: game-show register — "calls locked", "Rep on the line", "×9 Rep";
  never odds notation, never betting-slip vocabulary, no currency symbols.

## packages/market-engine (pure core)
Exports from `src/index.ts`:
- `compileClaim(parse: RawClaimParse, ctx: CompileContext): CompileResult`
  — closed-taxonomy validation, clarify generation ("in 90 or advancing?" when
  period ambiguous for match_winner in a knockout), counter-offers (player claim →
  oracle_resolved as-stated + chain_proven team upgrade), monetary-forfeit reject,
  window checks (INPLAY_MINT_CUTOFF_MINUTE, player claims pre-kickoff only,
  comeback only while trailing + requires anchor from ctx).
- `priceSpec(spec: MarketSpec, odds: OddsInputs, ctx: CompileContext): PriceQuote`
  — 1X2/totals direct ("market", FT_90 only); FT incl-ET/pens = modelled draw-mass
  split; team_scores_n / btts / player via independent-Poisson from totals line
  split by 1X2 lean (bivariate upgrade optional); clamp multiplier; carry odds pins.
- `reduceMarket(state: MarketState, event: MatchEvent): ReduceResult`
  — freeze on var_check/possible_event/odds_suspension + minute cutoffs; unfreeze on
  var_end (goal stands) / suspension end; pendingSettlement with debounce; reversal
  (goal_discarded/goal_amended referencing decidingSeq evidence) cancels pending;
  terminal phase settles per period semantics (FT vs FT_90 using score.p1Goals90);
  VOID_PHASES → void; own_goal never credits player claims; delay-snipe check:
  pending positions with placedAtMs > event.tsMs where event affects the market →
  void_positions effect; positions whose window elapsed → activate_positions.
- `checkDebounce(state: MarketState, nowMs: number): ReduceResult` — settles
  pendingSettlement whose debounceUntilMs passed.
- `evaluateSpec(spec: MarketSpec, score: ScoreState, phase: GamePhase): SettlementOutcome | null`
  — pure predicate used by reduceMarket; null = not yet decidable.
- Re-export everything from `./types.js` and `./constants.js`.
Tests (vitest, `src/**/*.test.ts`): the PRD's adversarial suite — goal→VAR→discarded,
goal→amend, duplicate seq, abandonment, ET/pens FT vs FT_90, own-goal, comeback anchor,
delay-window void, debounce settle, compiler matrix (each claim type × missing fixture /
unknown player / monetary forfeit / window closed / comeback without anchor), pricing
clamps + provenance rules. AIM: exhaustive; this package is the product's trust story.

## packages/txline
Exports from `src/index.ts`:
- `class TxlineClient` — ctor takes `{ apiBase, guestJwt, apiToken }`; methods:
  `fixturesSnapshot(params?)`, `scoresSnapshot(fixtureId, asOfMs?)`,
  `oddsSnapshot(fixtureId, asOfMs?)`, `statValidation(fixtureId, seq, statKey, statKey2?)`,
  `oddsValidation(messageId, tsMs)`. All via native fetch, dual headers
  (`Authorization: Bearer`, `X-Api-Token`), zod-parsed, descriptive errors.
- `startGuestAuth(apiBase): Promise<{jwt}>` (POST {apiBase}/auth/guest/start) and
  `activateToken(apiBase, jwt, txSig, walletSignatureB64, leagues): Promise<{apiToken}>`.
- `interface MatchEventSource { start(onEvent: (e: MatchEvent) => Promise<void>): void; stop(): void }`
- `class LiveSource implements MatchEventSource` — SSE over fetch ReadableStream for
  `/api/scores/stream` + `/api/odds/stream` (optional fixtureId filter), Last-Event-ID
  resume via injected `CursorStore { get(name): Promise<string|null>; set(name, id): Promise<void> }`,
  heartbeat timeout + reconnect with snapshot gap-fill callback.
- `class ReplaySource implements MatchEventSource` — ctor `{ client, fixtureId, speed }`;
  steps a virtual clock, polls `scoresSnapshot(fixtureId, asOf)` + `oddsSnapshot` at the
  virtual time, diffs successive snapshots into normalized MatchEvents.
- `normalizeScores(payload, receivedAtMs): MatchEvent[]` — raw TxLINE scores payload →
  MatchEvent(s): map statusSoccerId phases to GamePhase, dataSoccer → detail
  (Goal/PlayerId/GoalType/VAR flags → kind goal/var_check/card/etc.), scoreSoccer →
  ScoreState (track 90'-goals separately for FT_90), Amend/Discard actions →
  goal_amended/goal_discarded with reversesSeq.
- `normalizeOdds(payload): OddsInputs | null` — extract 1X2 + totals demargined Pct
  (strings, "NA" → null), carry MessageId/Ts. SuperOddsType strings are inventoried
  empirically — parse defensively, log unknown types.
Tests: normalization from SYNTHESIZED payload shapes (shaped per the OpenAPI spec at
https://txline.txodds.com/docs/docs.yaml — fetch it read-only for field names; do NOT
commit any real feed data), cursor resume, replay diffing.

## packages/agent
Exports from `src/index.ts`:
- `classifyMessage(text, entityHints, opts): Promise<{isClaim, confidence, claimTypeGuess}>`
  — model `glm-4.5-air`, strict JSON; `opts.client` injectable for tests.
- `parseClaim(text, ctx: CompileContext, opts): Promise<RawClaimParse>` — model
  `glm-4.6`, tool-use with grounded tools whose executors are injected:
  `{ searchFixtures, resolvePlayer, getMarketMenu }`; forced tool use then final JSON.
- `prefilter(text, entities: {teamNames: string[], playerNames: string[]}): boolean`
  — deterministic regex/dictionary gate that kills >95% of messages (claim verbs,
  numbers, team/player mentions).
- `persona(templateKey, vars, opts?): Promise<string>` — template bank (hand-written,
  game-show register) with optional haiku garnish; ALWAYS falls back to template on
  any error/timeout; deny-list check on output (no odds notation, no bookie words,
  no currency symbols) — violation returns raw template.
- `goldenSet`: exported array of ≥50 `{text, expected: RawClaimParse | null}` fixtures
  (slang, typos, non-claims) used by tests; tests run the PREFILTER + a MOCK parser
  against expectations (no live API in CI; live mode behind env flag).
Tests: prefilter matrix, deny-list guard, template rendering, golden-set harness.

## packages/solana
Exports from `src/index.ts` (node-side):
- `loadWallet(b58): Keypair`
- `subscribeTxline(conn, wallet, programId, txlMint, serviceLevelId, durationWeeks): Promise<string>`
  — Anchor `subscribe` on txoracle; TxL mint is TOKEN-2022 (use TOKEN_2022_PROGRAM_ID for
  ATA derivation). Fetch devnet IDL notes from
  https://txline.txodds.com/documentation/programs/devnet (read-only) — if exact IDL
  can't be obtained at build time, implement against a minimal local IDL json and mark
  clearly where to drop in the official one.
- `submitValidateStat(...): Promise<string>` — best-effort; structured error return.
- `signActivation(wallet, txSig, leagues, jwt): string` — ed25519 detached signature,
  base64, over `${txSig}:${leagues.join(',')}:${jwt}`.
Exports from `src/verify.ts` (ISOMORPHIC — no node-only imports; used by web):
- `verifyMerkleProof({leaf, proof, root}): boolean` and
  `fetchOnchainRoot(rpcUrl, programId, epochDay): Promise<string | null>` (via plain
  JSON-RPC fetch getAccountInfo on the daily_scores_roots PDA; PDA seed
  'daily_scores_roots' + epochDay — implement defensively, return null on unknown layout).
Tests: signature format vector, merkle verify with synthetic tree.

## packages/db
Exports from `src/index.ts`:
- `createEngineDb(url, serviceRoleKey)` → typed façade over supabase-js used by engine:
  groups/users/memberships upserts, `postLedger(entry)` (idempotency_key), balance query,
  claims CRUD by status, markets CRUD, positions insert + state transitions,
  `insertFeedEvent` (upsert-ignore on (fixture_id, seq), returns inserted boolean),
  settlements insert + `unpostedSettlements()` sweeper query, proofs upsert,
  stream cursor get/set, fixtures upsert, players/fixture_players upserts.
- Row types for every table (hand-written interfaces matching migrations/0001_init.sql).
Keep it a thin data layer — no business logic.

## apps/engine
Single process, `src/main.ts` boots: grammY bot (long polling via @grammyjs/runner,
auto-retry), per-chat send queue (~18 msg/min, collapse card edits per tunable),
ingest supervisor (LiveSource per live fixture — or ReplaySource when a replay is
active), settlement loop (feed_events → reduceMarket → ledger + cards), proof worker
(after settle: statValidation fetch → submitValidateStat best-effort → proofs row),
cron ticks via setInterval (fixtures sync 15min, matchday topup, morning slate,
claim TTL expiry, settlement sweeper).
Bot flows (inline keyboards, callback_data carries DB ids):
- message → prefilter → classify → 👀 react (medium) or priced nudge (high; price via
  latest odds snapshot) — only when group.is_admin (passive enabled), per chattiness.
- reply `/bookit` or @mention → same pipeline, works everywhere.
- nudge button "Make him prove it" → parseClaim → compileClaim → clarify buttons /
  counter-offer buttons / confirm gate "That's my shout" → market row + Claim Card.
- Back/Doubt taps → position insert (pending window per PENDING_TAP_WINDOW_MS pre-kickoff
  taps activate immediately), stake presets, cap enforcement, ephemeral errors
  ("pick a lane", insufficient Rep).
- Commands: /start (intro + disclosure), /settings (admin, chattiness buttons),
  /table (leaderboard), /replay <fixtureId> (admin; flags markets is_replay),
  /bookit (reply trigger), /help. Stale/expired callback taps → in-character decline.
Cards are TEXT-FIRST (OG images are cut per PRD cut order). Every card links
`${WEB_BASE_URL}/r/<marketId>` and `/g/<slug>`.
Persona strings ONLY via packages/agent persona().

## apps/web (Next.js 15 App Router, Tailwind v4, minimal shadcn-style components)
Pages:
- `/r/[marketId]` — receipt: quoted claim, terms (plain English from spec), price +
  provenance chip, status timeline, derived evidence list (from public_evidence via
  market's evidence_seqs), trust badge. If settlement tier chain_proven and proof row
  verified → green "Chain-proven ✓" + explorer link; client component attempts
  in-browser re-verification via @calledit/solana/verify against
  NEXT_PUBLIC_SOLANA_RPC_URL (graceful "verification unavailable" fallback). Realtime
  subscription flips badge live.
- `/g/[slug]` — leaderboard + Hall of Calls (top 5 settled receipts by multiplier) +
  recent receipts. 404s cleanly when group web_enabled=false.
- `/` — one-screen product explainer + link to demo group + sample receipt.
Anon supabase client reads ONLY the public_* views. Dark, mobile-first, fast; no auth,
no client writes. Design: bold type, high contrast, feels like a match-night product —
not a dashboard.
