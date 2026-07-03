# "Called It" — Concept Brainstorm v1 (2026-07-02)

Produced by an 11-agent panel: TxLINE feasibility deep-dive (OpenAPI spec + soccer-feed PDF),
competitive landscape sweep, hackathon winner-pattern research, 4 idea-refinement lenses,
3 adversarial judges (track-criteria judge, USP assassin, delivery realist), 1 architect.
Working name: **Called It** (alternative candidate: **Receipts**). Target track: Consumer &
Fan Experiences (4 submissions as of 2026-07-02 — least crowded).

---

## 1. The refined idea in one paragraph

Called It is a Telegram bot that lives inside an existing friends' group chat and turns
trash talk into instantly-priced, provably-settled peer markets — for points and social
forfeits, never money. When a mate types "Mbappé's scoring twice today", the bot detects the
claim and silently reacts 👀; any friend can tap **"Make him prove it"** to mint the market.
The bot formalizes the claim (asking one charming clarifier when ambiguous: "In 90 minutes,
or advancing on pens?"), checks it against a closed taxonomy of verifiable claim types,
prices it off TxLINE's live demargined probabilities at that exact second, and posts a Claim
Card with one-tap Back/Fade buttons. During the match it narrates the sweat — scorer-named
goal alerts, "VAR check — market frozen" freezes, live price swings — and the moment the
deciding stat lands it settles instantly and posts a receipt, before the TV replay finishes.
Team-level claims upgrade to a **Chain-proven ✓** badge (TxLINE Merkle proof verified
against the Solana-published root, viewable by anyone in a browser with no wallet); player
claims settle honestly as **Oracle-resolved** from the signed feed.

**USP sentence (the pub test):** "Our group chat has its own bookie — when Dave said Mbappé
scores twice it priced him at 11-to-1 on the spot, we all piled in against him, and it paid
the receipt before the TV replay finished. Nobody's argued about a bet since."

---

## 2. What changed from the raw idea, and why

| # | Raw idea | Refined | Why (evidence) |
|---|---|---|---|
| 1 | Bot creates market when it sees a claim | A **friend's challenge tap** mints the market ("Make him prove it" / reply "book it") | Kills bot-spam, doubles the social roles (claimer vs challenger), makes minting itself a social act. Also neutralizes the Telegram privacy-mode objection — reply-trigger works with privacy mode ON. |
| 2 | "Test if the claim is verifiable" (binary) | **Verifiability negotiation**: when a claim isn't provable as stated, the bot counter-offers the nearest provable market with trust-tier badges | TxLINE's on-chain proofs are team-level only; player events are feed-resolvable but not chain-provable. Negotiation turns the API's limitation into the signature agentic behavior — the demo's best beat. |
| 3 | "Anyone can wager into the bet" (money implied) | **Points + bot-enforced social forfeits; zero real money, zero wallets** | Real-money P2P wagering = unlicensed gambling in most jurisdictions; the consumer brief explicitly warns against gambling-feel; judges can't need funded wallets; TxL token is contractually barred from wagering. The USP judge's single highest-delta change: promote forfeits (avatar takeover, coffee run — pinned and publicly nagged by the bot) to the primary stake of big calls. Forfeits are the one thing screenshots can't enforce and money apps can't offer. |
| 4 | Odds "from TxLINE" | **Price-at-claim-second with provenance**: direct demargined Pct for 1X2/totals/AH; transparent Poisson-derived "modelled" prices for BTTS/team-totals/player props; every quote pins the odds record's MessageId+Ts so the price itself is provable via `/api/odds/validation` | TxLINE StablePrice publishes 1X2, Asian handicap (incl. quarter lines), and totals — NO player props, correct score, or BTTS. Derived pricing is required and must be labelled honestly. |
| 5 | (not in raw idea) | **Two-tier trust badges**: Chain-proven ✓ (team stats, Merkle + `validate_stat`) vs Oracle-resolved (player events from the signed feed) | Honesty about the proof boundary is itself judge-impressive UX, and it converts the sponsor's on-chain verification layer into a consumer-facing feature — the thing no other entry shape does. |
| 6 | (not in raw idea) | **Replay mode is a core feature**: `asOf`-parameter snapshot stepping re-runs a real finished match through the *identical* pipeline | Judging runs Jul 19–29, after the final. Recorded TxLINE data can't ship in the repo (license). Replay doubles as the settlement regression harness and new-group onboarding. |
| 7 | (persona implied "bookie") | **Game-show register, not sportsbook register** ("Data says 9% — spicy", calls, receipts, Rep) — no "11/1", no bankroll/bookie vocabulary | The track-criteria judge KILLED the bookie framing: the brief explicitly warns against making a casual fan game feel like gambling. Vocabulary is a disqualification-adjacent risk, not a style choice. |
| 8 | "Messi scores 2" as the flagship | Flagship on-camera claim is **team-level** ("France score 2+" → Chain-proven); player brace is a stretch goal with a Jul 12 go/no-go | Player claims: lineups (PlayerId→name map) publish near kickoff → "pending lineup" state; own-goal exclusions; modelled price. Feed-resolvable, but the riskiest claim type — never let the demo's proof moment depend on it. |

## 3. The load-bearing feasibility finding

**"Messi scores 2 goals today" IS resolvable from TxLINE** — with one caveat.
The scores feed's `dataSoccer` payload carries per-event `Goal: bool`, `PlayerId`, `Minutes`,
`GoalType (Head|Shot|OwnGoal|Other)`, `Penalty`, `VAR`; and the same feed delivers `lineups`
→ `PlayerData {preferredName, team, normativeId}` — so goals arrive scorer-attributed and
PlayerId resolves to "Lionel Messi" with no third-party data. Resolution: count confirmed
goal events for the player, excluding own goals, surviving Amend/Discard/VAR-End reversals,
settled at terminal phase (F/FET/FPE).
The caveat: the on-chain Merkle stat tree covers only team-level stat keys 1–8 (goals,
yellows, reds, corners per participant, period-encoded). PlayerId is not in the tree, and
StablePrice has no player-prop odds. Hence the two-tier design.

**Claim taxonomy v1 (6 types, all fully wired):**

| Claim type | Resolvable from feed | Chain-provable | Priceable |
|---|---|---|---|
| Match winner (1X2) | yes (phase-aware: "in 90" vs "advancing") | yes (two-stat subtract) | direct |
| Total goals over/under | yes | partial (verify operator enum in IDL; V2 fallback) | direct |
| Team scores N+ | yes | **yes — cleanest proof; flagship** | derived |
| Both teams score | yes | yes (V2 two-stat) | derived (Poisson) |
| Player scores N ("Messi ×2") | yes (scorer events + lineups) | no — Oracle-resolved tier | modelled (labelled) |
| Comeback ("we turn this around") | yes (InRunning state + final result) | yes (team stats) | direct (live 1X2 at claim time) |

Key gotchas baked into the design: never settle instantly on a goal event (confirmed +
debounce for VAR/Amend); `possibleEventSoccer` flags freeze staking (and make great drama);
own goals credit team not player; chain proofs lag ~5 min (async badge upgrade, not a
blocking wait); "Unreliable Corners/Yellow Cards" messages mean corners/cards markets stay
out of v1; participant1IsHome is a listing convention, not venue truth; `SuperOddsType`
strings and `Prices[]` scaling must be inventoried empirically on day 1.

## 4. USP delta — scored honestly

The job is not "wagering". It is: **capture, price, and make a specific friend own his
spontaneous claim, then settle it before the argument starts.**

- Honest incumbent (screenshot + memory + social pressure + Venmo): **3/10** (not 2 — it
  works tolerably and banter is free; use 3 in all planning docs so no judge catches us
  inflating).
- Called It on that job: **8/10** → **delta ≈ 5, achievable** — but only on this job.
- Adjacent jobs where the delta collapses (do NOT pitch these): tournament-long competition
  vs Superbru/Kicktipp (delta ~2); "real thrill" vs Polymarket/sportsbooks (we lose unless
  forfeits carry the stakes).
- The brag sentence works WITHOUT the crypto clause. "Paid in full, receipt posted" is the
  fan sentence; "Merkle-proven against the txoracle root" is the interview sentence.

## 5. Competitive landscape (why the position is empty)

Nobody occupies **"the market comes from the conversation."** Incumbents fall into three
camps: (a) exchange-authored markets brought INTO chat (Polymarket TG bots, ChatBet,
ParlayBay — all house catalogues, can't mint a friend's claim), (b) pre-built pool templates
in a destination app (Splash, Sleeper, Superbru, Wagr — nothing spontaneous or in-match),
(c) on-chain betting rails with no social surface (Azuro, Overtime, SX Bet, BetDEX).
Closest analogue: **Predo** (Telegram + Gemini + USDC on Solana) — dormant repo, 7 stars, no
sports-data integration, no odds pricing, no proof layer. **Wagr** ($16M raised, dead by
2022) is the cautionary tale proving friend-vs-friend demand AND that a destination app
fails because the conversation never moves there — which is exactly why chat-native matters.

## 6. Moat — stated honestly

There is **no technology moat** (the USP assassin killed that claim; never say "moat = tech"
in the pitch). Real defensibility, framed honestly: (1) per-group rivalry history and
receipts corpus — data that doesn't port and is socially expensive to abandon; (2)
tournament-window distribution land-grab via receipt-forwarding (`startgroup` deep links);
(3) settlement-correctness craft — the VAR-safe state machine is the hard 20% a weekend
clone gets wrong; (4) free-to-play needs no license/KYC/geo-gating, so it can spread
globally where ChatBet/ParlayBay structurally cannot.

## 7. Judge panel verdict

Track-criteria judge: **SHORTLIST, frontrunner in a 4-entry track** — predicted scores: Fan
Accessibility 8.5, Real-Time 9, Originality 8, Commercial 6.5 (weakest), Completeness 7.
Survived: "it's just the brief's own examples glued together" (a pundit bot broadcasts AT
the group; a sweepstake pools pre-defined outcomes; neither can mint a market from a
friend's quoted sentence, price it at that second, or settle with proof), "repackaged feed",
"dead tournament at judging", "cosmetic Solana". **Killed: gambling-feel** (fixed by the
game-show register) and **zero-tech-moat** (fixed by honest framing).

Delivery realist: **shippable ONLY as the merged minimum-lovable cut** — every lens variant
as written was 30–40 person-days in a 17-day window. What breaks first: (1) a Vercel-only
architecture (SSE + Telegram need a persistent process — decided day 1, see architecture),
(2) the TxLINE auth chain + level-12 real-time GO/NO-GO (first task, Jul 3), (3) VAR-safe
settlement (replay-first regression discipline), (4) the "wow moment" being a player prop
(re-scripted to team-level).

Hard cut list (all four lenses' extras, killed): soulbound receipt mints, cash-out/EV
offers, unprompted market minting, forfeit-enforcement *machinery* (one pinned line max),
rivalry-instigation engine (simple leaderboard + h2h tally only), Telegram mini-app,
parlays, custom stakes, exact-score/corners/cards claims, multi-language, WhatsApp/Discord.

## 8. Technical structure (architect output, tightened from your loose picks)

**Stack:** Turborepo + pnpm; **two apps**: `apps/web` (Next.js App Router + shadcn/ui on
Vercel — public receipt pages, group leaderboard, `@vercel/og` card images, zero auth) and
`apps/engine` (ONE long-running Node process on Railway: grammY long-polling bot + TxLINE
SSE ingestion + settlement + async proof submitter + cron). Supabase Postgres (service-role
writes from engine only; anon read-only RLS views for web; Realtime flips the receipt badge
live in the browser). Claude API: haiku-4-5 classifier → sonnet-5 strict-tool parse →
opus-4-8 only on compile-reject; persona copy is haiku garnish over templates with
deterministic fallback. Solana: web3.js v1 + Anchor against txoracle on **mainnet** (forced:
free real-time level 12 is mainnet-only; TxL subscribe is Token-2022), one server hot
wallet; browsers verify Merkle proofs client-side via public RPC — no wallet for anyone.

**Why not Vercel-only:** TxLINE SSE streams and Telegram long-polling are persistent
connections — structurally impossible on serverless. This is the #1 silent failure mode;
the worker exists from day 1.

```
calledit/
├── apps/
│   ├── web/                    # Next.js + shadcn — receipt pages /r/[marketId], leaderboard
│   │                           #   /g/[groupSlug], /api/og card images; Vercel
│   └── engine/                 # ONE Node process — Railway (Docker via turbo prune)
│       └── src/{main,bot,agent,ingest,settle,proofs,cron}/
├── packages/
│   ├── txline/                 # auth chain, SSE + Last-Event-ID resume, asOf snapshots,
│   │                           #   stat/odds validation, zod schemas, Prices/Pct parsing
│   ├── market-engine/          # PURE deterministic core: 6-type MarketSpec compiler +
│   │                           #   counter-offers, pricing (Pct + Poisson), settlement
│   │                           #   state machine — zero I/O, replay-tested in CI
│   ├── agent/                  # Claude layer: classify/parse/tools/persona + 50-phrase
│   │                           #   golden regression set
│   ├── db/                     # supabase client, generated types, SQL migrations
│   ├── solana/                 # txoracle Anchor client (Token-2022 subscribe,
│   │                           #   validate_stat) + isomorphic merkle verify (browser+node)
│   └── config/                 # shared tsconfig/eslint
└── scripts/bootstrap.ts        # one-time TxLINE guest auth → subscribe → activate
```

**Agent pipeline — "LLM proposes, code disposes":** deterministic regex/entity prefilter
(kills >95% of messages) → haiku classify → silent 👀 react → friend's tap escalates →
sonnet-5 parse with strict grounded tools (`search_fixtures`, `resolve_player`,
`get_market_menu` — entity IDs must exist in our DB, hallucination structurally impossible)
→ **deterministic** taxonomy compiler emits clarify/counter-offer buttons → claimer confirm
gate ("That's my shout") → deterministic pricing (multiplier clamped ×1.02–×25, provenance
chip) → deterministic settlement (seq-ordered, confirmed-only, VAR/Amend-debounced) → async
chain-proof badge upgrade. The LLM can embarrass the copy, never the ledger.

**Data model (13 tables):** groups, users, memberships (bankroll + h2h), ledger_entries
(append-only, source of truth), fixtures (cron-discovered; knockout IDs appear dynamically),
players (normativeId-keyed, alias-accumulating), fixture_players (lineup binding), claims,
markets (spec jsonb + pinned odds MessageId/Ts), positions (per-tap locked multiplier +
provable price), feed_events (UNIQUE(fixture_id, seq) idempotency), settlements
(evidence_seqs cited on receipts), proofs (Realtime → live badge flip), stream_cursors
(kill-9-safe SSE resume).

**Ingestion abstraction (load-bearing):** `MatchEventSource` interface with `LiveSource`
(SSE) and `ReplaySource` (asOf stepping at 10–30×) — the demo replays byte-for-byte the same
pipeline. Never recorded JSON (license risk), never `scores/historical` (6h–2wk window dies
during interviews).

## 9. Calendar with hard gates (deadline 2026-07-19 23:59:59 UTC)

- **Jul 3 (day 1):** full TxLINE auth chain spike (curl-level); level-12 real-time GO/NO-GO
  by Jul 4 (if 60s only → premise rewrites to "settled before the argument ends");
  SuperOddsType + Prices[] scaling inventory during a live match; ask TxODDS about
  post-deadline API access + one-prize rule; provision Railway worker + repo scaffold.
- **Jul 3–9 (week 1):** txline client + ingestion + replay harness; market-engine compiler
  + settlement state machine with VAR regression suite (CI-gated); bot loop for 2 claim
  types; core-loop gate **Jul 9** (slip past Jul 11 → permanently cut player props +
  passive detection).
- **Jul 9–11 (QF window):** live-fire in 2–3 real friend groups; bank live demo footage;
  goal-burst throttling test.
- **Jul 10–16 (week 2):** remaining claim types, receipt pages + in-browser Merkle verify,
  chain-proof submitter (timeboxed 2 days; read-only verify is the shipped fallback),
  leaderboard, persona pass, passive detection behind confidence threshold (optional).
- **Jul 14–15 (SF window):** second live-fire; **feature freeze Jul 15**; outsider cold-test
  Jul 16.
- **Jul 17–18:** demo video (≤3 min effective: minting moment in first 30s → receipt-beats-
  the-replay climax → forfeit laugh → proof-badge coda; never open with goal narration);
  tech docs naming exact endpoints; TxLINE feedback write-up (the odds-inventory findings
  are easy points).
- **Jul 19 (final + deadline):** submission mechanics ONLY. No product code.

## 10. Open decisions for the team

1. **Stakes model sign-off (biggest deviation from the raw idea):** points + forfeits, zero
   real money — every lens and judge converged here. The optional devnet USDC "crew pot" was
   cut. Confirm you're comfortable dropping real wagering for the hackathon build.
2. **Name:** Called It vs Receipts (bot handle availability check needed).
3. **Team size** (max 3, natural persons; affects scope confidence).
4. **Passive detection** (privacy mode off) as week-2 optional vs cut entirely.
5. Mainnet hot-wallet budget (small real SOL) — confirm OK.

## 11. Questions to ask TxODDS (t.me/TxLINEChat) in week 1 — keep screenshots

1. Does API access/data license survive Jul 19 → Jul 29 for judging? (Hedge: start the
   28-day free subscription ~Jul 5.)
2. Confirm one-prize-total rule (we're single-tracking regardless).
3. Is level-12 real-time actually free on mainnet for hackathon guests? Devnet status?
4. May small recorded payloads ship in the public repo for tests? (Default: no.)
5. Post-Jul-4 knockout fixture coverage timing (fixtures/snapshot polling cadence).
