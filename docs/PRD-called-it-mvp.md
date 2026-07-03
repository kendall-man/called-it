# PRD: Called It — MVP (World Cup Hackathon, Consumer & Fan Experiences track)

- Status: ready-for-agent
- Version: 1.1 (2026-07-03) — v1.0 reviewed by a 3-agent adversarial panel
  (fact-consistency, implementability, hackathon-rules compliance); all 29 verified
  findings applied.
- Deadline context: submission 2026-07-19 23:59:59 UTC; judging + live interviews through
  ~2026-07-29
- Network decision: **Solana devnet** (TxLINE devnet API host + devnet txoracle program)
- Source material: `docs/concept-brainstorm-2026-07-02.md`, `reference/audit-2026-07-02.md`,
  `reference/*.md` (hackathon + track briefs). This PRD is self-contained but those
  documents carry the evidence for every decision below.

## Problem Statement

When friends watch football together in a Telegram group chat, someone always makes a bold
claim — "Mbappé scores twice today", "we turn this around", "over 2.5 easy". Today that
moment dies: the claim has no precise terms, no price (a wild long-shot shout carries the
same social stake as a coin flip), nobody remembers it after the match, settlement is a
screenshot argument ("I said two OR more"), and any real follow-through means chasing
someone on Venmo. Half of these bets simply evaporate. The banter is the best part of
watching football with friends, and there is no product where the banter itself becomes the
game — existing apps either import house-authored markets into chat (Polymarket bots,
ChatBet), require leaving the chat for a pre-formatted pool (Splash, Superbru), or are
wallet-gated betting rails with no social surface at all (Azuro, BetDEX).

For the hackathon sponsor, the problem is adjacent: TxODDS has a cryptographically
verifiable sports-data oracle on Solana (TxLINE) and no consumer-facing showcase that makes
verification meaningful to a mainstream fan.

## Solution

**Called It** is an agentic Telegram bot that lives inside an existing friends' group chat
and turns spontaneous claims into instantly-priced, provably-settled peer markets — played
for Rep (points) and social forfeits, never money.

The bot watches the group's messages (agentic, always-on, enabled per-group). When someone
posts a recognizable claim, it responds right there and then with a one-line priced nudge —
"Big shout. Data says 9% — anyone want to make him prove it?" — and any friend can tap
**Make him prove it** to mint the market. If the claim is ambiguous the bot asks exactly one
clarifying question with buttons ("In 90 minutes, or advancing on pens?"). If the claim
can't be verified as stated, the bot performs its signature move — **verifiability
negotiation** — counter-offering the nearest verifiable market with an honest trust tier:
*"I can't chain-prove Messi personally — on-chain stats are team-level. Book it
Oracle-resolved as stated, or upgrade to 'Argentina scores 2+' Chain-proven?"*

Once the claimer confirms ("That's my shout"), a Claim Card posts with the formalized terms,
the probability derived from TxLINE's most recent odds update at the moment of the claim,
and one-tap **Back** / **Doubt** buttons committing preset amounts of Rep. During the match
the bot narrates against open markets — scorer-named goal alerts, "VAR check — calls locked"
freezes, price swings — and once the deciding stat is confirmed in the feed it settles
deterministically and posts a Receipt Card: winner, Rep moved, and a trust badge. Team-stat
claims asynchronously upgrade to **Chain-proven ✓** — a TxLINE Merkle proof verified against
the Solana-published root, viewable by anyone on a public web receipt page with no wallet,
no login, no app install (contingent on devnet proof-root publication — day-1 spike; falls
back to signed-feed verification with the same UX). Big claims can carry a social forfeit
(one pinned line the bot remembers and surfaces at settlement). A per-group leaderboard and
head-to-head records keep score across the knockout rounds.

Because judging happens after the World Cup final, the same pipeline runs in **replay
mode**: any finished match can be re-streamed at accelerated speed from TxLINE point-in-time
snapshots, driving the identical detection → pricing → freeze → settlement → proof loop in
any group, on demand — and a settled corpus of replayed markets remains browsable on the
public web surface even with zero API access.

## User Stories

### Onboarding & group setup

1. As a group member, I want to add the bot to my existing Telegram group in one tap from a
   shared link, so that my group can start playing without anyone installing an app or
   creating an account.
2. As a group member, I want the bot to introduce itself with a single short message
   explaining what it does, that enabling always-on detection means granting it admin (so it
   can see messages), that receipts and the leaderboard are viewable at a web link, and that
   it plays for points only, so that the group consents to how it works and nobody expects
   real money.
3. As a group admin, I want a `/settings` command (admin-only, inline buttons) to set how
   chatty the bot is — priced-nudge mode (default), react-only mode, or trigger-only mode —
   so that the bot matches my group's tolerance for bot messages.
4. As a group member, I want every member to receive a starting Rep balance automatically on
   first interaction, so that there is no sign-up step before the first tap.
5. As a group member, I want my Rep balance topped up to a floor on each matchday, so that
   going broke never locks me out of the next match's banter.
6. As a privacy-conscious group, we want a trigger path that works without granting the bot
   message access — reply to any claim with `/bookit` or an `@CalledItBot` mention — so that
   we can use the product without always-on detection.

### Claim detection & the agentic response

7. As a claimer, I want the bot to notice my spontaneous claim in normal chat and respond
   right there and then with the current probability, so that my hot take gets a price while
   the moment is still alive.
8. As a group member, I want the bot to stay silent on ordinary conversation and only react
   to genuine claims, so that it never spams the chat or feels creepy.
9. As a group member, I want low-confidence detections acknowledged with only a silent 👀
   reaction (no message), so that borderline cases don't create noise.
10. As a challenger, I want a **Make him prove it** button on the bot's nudge, so that the
    group — not the bot — decides which banter becomes a market.
11. As a claimer, I want to confirm the formalized terms with a **That's my shout** button
    before any market opens, so that I'm never booked into terms I didn't mean.
12. As a claimer, I want the bot to ask exactly one clarifying question when my claim is
    ambiguous ("in 90 minutes, or advancing?"), answerable with buttons, so that precise
    terms never require typing.
13. As a claimer whose claim can't be verified as stated, I want the bot to counter-offer
    the nearest verifiable version with an honest explanation of the trust tier, so that I
    can still get my moment instead of a dead "can't do that".
14. As a claimer whose claim references a fixture or player the bot can't ground in today's
    fixtures, I want a polite in-character decline, so that unmintable claims fail
    gracefully.
15. As a group member, I want the bot to refuse any claim that stakes money or anything of
    monetary value ("loser sends $20"), so that the game stays clearly on the right side of
    gambling law.
16. As a claimer, I want claims about a player made before lineups are published to be held
    in a visible "pending lineups" state and activated (or voided with refunds) when the
    lineup lands, so that pre-match player banter still works.
17. As a group member who taps a stale button (a nudge for an expired claim, a confirm after
    kickoff, a card from before a bot restart), I want a deterministic in-character "that
    ship has sailed" answer, so that old messages never cause broken or duplicate markets.

### Markets, pricing & staking

18. As a group member, I want the Claim Card to show the formalized terms, the claimer, the
    probability at claim time, the Rep multiplier, and who has taken which side, so that the
    whole market is legible at a glance in chat.
19. As a backer or doubter, I want one-tap participation with preset Rep amounts, so that
    joining a market takes one second during a live match.
20. As a group member, I want my Rep multiplier locked at the price of the moment I tapped,
    with each tap being its own position, so that everyone's payout reflects the information
    available when they committed.
21. As a group member, I want prices derived from real market odds labelled "market" and
    model-derived prices labelled "modelled", so that I know what the number is worth.
22. As a group member, I want multipliers clamped to a sane range and per-market stakes
    capped, so that one lucky long-shot doesn't destroy the season leaderboard.
23. As a claimer, I want an optional one-line social forfeit attached to my claim (chosen
    from a curated pack), so that big calls carry real social stakes the bot will remember.
24. As a group member, I want the game protected from TV-delay sniping — taps that land
    after the moment has already happened on the pitch are voided and refunded — so that
    playing against friends watching the broadcast stays fair even on a delayed data feed.
25. As a group member, I want to see a live pot tally and side counts update on the card as
    friends pile in, so that the market itself becomes the conversation.

### Live match experience

26. As a group member, I want goal alerts that name the scorer and minute and reference the
    open markets they affect, so that the bot's narration is about *our* bets, not generic
    commentary.
27. As a group member, I want the bot to lock affected markets and announce "VAR check —
    calls locked" when the feed flags a review, so that drama on the pitch becomes drama in
    the chat.
28. As a group member, I want open market cards to update their price when the probability
    moves meaningfully, so that I can feel the match swing.
29. As a group member, I want the bot's messages rate-limited and card edits collapsed
    during goal bursts, so that the chat stays readable at the most exciting moments.
30. As a group member, I want the bot to handle a match being postponed, abandoned, or
    losing coverage by voiding open markets and refunding Rep with a clear message, so that
    edge cases never strand anyone.

### Settlement, receipts & proofs

31. As a winner, I want settlement to land in the chat seconds after the deciding stat is
    confirmed in the feed — with Rep paid at my locked multiplier — so that the result is
    settled and paid before the argument ends.
32. As a group member, I want settlement to survive VAR reversals and amended events (the
    bot never pays out on a goal that gets chalked off), so that the "never argues" promise
    holds even in chaos.
33. As a winner, I want a Receipt Card quoting my original message, the terms, the price I
    got, and the outcome, so that I can forward my triumph to other chats.
34. As a skeptic who lost, I want the receipt to link a public web page showing the derived
    facts of the resolving events (event type, minute, scorer where applicable, sequence
    references, confirmation status), so that I can verify the outcome instead of trusting
    the bot.
35. As any web visitor, I want team-stat receipts to verify their TxLINE Merkle proof
    against the Solana-published root live in my browser — flipping a badge to
    "Chain-proven ✓" with an explorer link — without a wallet, login, or extension, so that
    "provably settled" is something I can see, not a slogan. (Contingent on devnet
    proof-root publication; falls back to signed-feed verification, same badge UX with an
    honest label.)
36. As a group member, I want player-level claims honestly badged "Oracle-resolved" (signed
    feed, not chain-provable) with the tier explained in one tappable line, so that the
    trust story is honest rather than overclaimed.
37. As a loser with a forfeit attached, I want the bot to announce my forfeit at settlement
    and pin it (or post it prominently if it lacks pin rights) until an admin taps
    **Honored ✅**, so that social stakes actually get enforced.
38. As a group member, I want every Rep movement recorded in an auditable ledger the
    leaderboard is computed from, so that balances always reconcile.

### Competition & retention

39. As a group member, I want a per-group leaderboard (`/table`) with Rep, record, and
    current streak, so that the tournament has an ongoing story.
40. As a rival, I want my head-to-head record against a specific friend shown when we take
    opposite sides, so that grudges accumulate.
41. As a group member, I want a morning slate message on matchdays listing today's fixtures
    (and any of our pending claims), so that the group wakes up to the day's card.
42. As a winner, I want my receipt card to carry a deep link that adds the bot to a new
    group in one tap, so that bragging in other chats spreads the product.

### Demo, replay & judge access

43. As a group admin, I want a `/replay` command that re-runs a real finished World Cup
    match at accelerated speed through the identical live pipeline — claims, pricing,
    freezes, settlement, proofs — so that the full product is experienced on demand after
    the tournament ends. Replay markets are flagged and excluded from the season
    leaderboard.
44. As a judge, I want a public demo group joinable via a link in the submission, pre-loaded
    with a replay-ready fixture, so that I can experience the loop in under 60 seconds.
45. As a screening judge who won't join a Telegram group, I want the public web surface —
    receipt pages, group leaderboard with its Hall of Calls section, and a read-only
    "watch a replay run" view — to show a complete claim → market → freeze → settle → proof
    story in a browser, so that the product is evaluable with zero accounts.
46. As a judge evaluating after the tournament (and possibly after data access ends), I want
    the demo group and web surface to already hold a complete settled corpus of replayed
    markets, so that the product remains demonstrable even if the TxLINE API is dark.
47. As the team, we want the demo video recordable entirely from replay mode with banked
    live-match footage spliced in, so that the video doesn't depend on a live match at
    recording time.

### Operations & evidence (team-facing)

48. As the team, we want the TxLINE auth chain (guest JWT → on-chain devnet subscribe →
    token activation) automated in a bootstrap script with clear failure messages, so that
    credential setup is reproducible and renewable before expiry.
49. As the team, we want the SSE ingestion to resume from its last event after any crash or
    redeploy (persisted cursors + snapshot gap-fill), so that a minute-80 restart never
    loses a settlement.
50. As the team, we want every LLM output that could touch state to pass a deterministic
    compiler gate, so that a model mistake can embarrass the copy but never the ledger.
51. As the team, we want per-group daily LLM budgets with an in-character degradation mode
    (trigger-only) when exceeded, so that a hyperactive group can't run up the bill.
52. As the team, we want structured logs of every detection, parse, compile, price, freeze,
    and settlement decision, so that any disputed market can be reconstructed after the
    fact.
53. As the team, we want usage metrics captured from live-fire groups (groups created via
    receipt deep links, claims per matchday, members returning the next matchday), so that
    the commercial-path story in the submission is backed by observed numbers rather than
    assertion.
54. As a group admin, I want a command to disable my group's public web pages, so that our
    banter never has to be visible outside the group.

## Implementation Decisions

### Network: devnet (explicit user decision) and its consequences

- All TxLINE access uses the devnet API host, devnet guest-auth endpoint, devnet txoracle
  program, and devnet TxL mint. One network everywhere — devnet subscriptions cannot be
  activated against the mainnet host.
- Devnet documents only service level 1 (World Cup, **60-second delay**). Consequences
  accepted and propagated:
  - The product premise is **"settled before the argument ends"** — never "before the TV
    replay". No consumer copy, demo script, or README may make a latency claim the tier
    can't honor.
  - **Delay-arbitrage guard (fairness mechanic, not optional):** anyone watching TV knows
    about a goal ~60s before the feed does, so tap-time price locks alone cannot prevent
    sniping. Decision: in-play taps enter a **pending window equal to the measured feed
    delay + settlement debounce**; when a price-moving event (goal, red card, penalty
    award) arrives whose event timestamp precedes a pending tap's wall-clock time, that tap
    is voided and refunded with an in-character note ("after the moment — no Rep moved").
    Taps that clear the window activate at their locked price. If the day-1 spike finds a
    real-time tier on devnet, the same mechanism runs with a ~5s window; nothing else
    changes.
  - Day-1 spike must (a) read the devnet on-chain pricing matrix for a real-time free tier,
    (b) confirm live World Cup data flows on the devnet host, (c) confirm daily scores
    Merkle roots are published on-chain on devnet (if not: Chain-proven badge falls back to
    signed-feed verification with an honest label; settlement is unaffected), (d) measure
    real amend/VAR-reversal latencies to set the debounce constant, and (e) inventory
    odds-market types and price scaling empirically.
- Devnet benefits banked: hot wallet funded by airdrop (no real money), zero mainnet-fee
  anxiety, track listing explicitly allows devnet. The team wallet is a single server-side
  keypair; end users and judges never need any wallet — browsers verify proofs read-only
  against a public devnet RPC.

### Architecture

- Turborepo monorepo, pnpm. Two deployables: a public **web app** (Next.js App Router,
  shadcn/ui, on Vercel — receipt pages, group leaderboard with Hall of Calls, replay
  viewer, OG-image card renderer, no auth) and one **engine** — a single long-running Node
  process (Railway or equivalent) hosting the Telegram bot (grammY, long polling), TxLINE
  SSE ingestion, the settlement loop, the async proof submitter, and cron jobs (fixture
  sync, matchday top-ups, credential expiry checks). Rationale: SSE and long polling are
  persistent connections and cannot run on serverless; colocating them means a confirmed
  event settles and posts in one call stack.
- Supabase Postgres is the system of record. The engine writes exclusively via the
  service-role key; the web app reads via the anon key through read-only RLS views (settled
  markets, receipts, leaderboard). Zero client-side writes exist. Supabase Realtime on the
  proofs/settlements tables drives the live badge-flip on receipt pages.
- **All conversational state is persisted, never in-memory.** Claims are DB rows moving
  through `detected → nudged → clarifying → awaiting_confirm → confirmed | expired`, with
  the claim ID carried in inline-keyboard callback data, so every button tap resolves
  against the database and survives restarts and redeploys. Stale or expired taps get a
  deterministic in-character answer. Unconfirmed claims expire at fixture kickoff
  (pre-match types) or after a 10-minute TTL (in-play).
- Shared packages: a typed TxLINE client (auth chain, SSE with resume, point-in-time
  snapshots, validation endpoints, zod-parsed payloads); a **pure deterministic
  market-engine** (taxonomy compiler, pricing, settlement state machine — zero I/O); an
  agent package (LLM calls, prompts, golden fixtures); a db package (schema, migrations,
  typed queries); a Solana package (txoracle subscribe + validate_stat + an isomorphic
  Merkle-verify usable in both engine and browser).

### The agent: LLM proposes, code disposes

- Three LLM touchpoints only, everything else deterministic:
  1. **Claim classification** — small fast model (Haiku-class) behind a deterministic
     regex/entity prefilter built daily from the fixtures/players tables; the prefilter
     kills >95% of messages before any model call. Output: `{is_claim, confidence,
     claim_type_guess}`. Confidence ≥ 0.85 → priced nudge; 0.5–0.85 → silent 👀; below →
     nothing. (Thresholds are named constants; see tunables.)
  2. **Claim parse** — Sonnet-class model with forced tool use against grounded tools
     (`search_fixtures`, `resolve_player`, `get_market_menu`) whose results come from our
     DB; entity IDs that don't exist cannot be produced. Output is a candidate MarketSpec.
     One escalation to the top-tier model when the compiler rejects a parse.
  3. **Persona copy** — small model garnish over a hand-written template bank, hard-capped
     per match, with deterministic template fallback on any failure/timeout. The bot is
     never blocked on a model call.
- The **MarketSpec compiler** is the single gate between LLM output and state. Closed
  taxonomy (shape sketched during this hackathon's design phase; all code will be written
  fresh in-repo during the hackathon window):

  ```
  MarketSpec = {
    claimType: 'match_winner' | 'totals_ou' | 'team_scores_n'
              | 'btts' | 'player_scores_n' | 'comeback'
    fixtureId: number               // must exist in fixtures table
    entityRef: TeamRef | PlayerRef  // must resolve in our tables
    comparator: 'gte' | 'lte' | 'eq'
    threshold: number
    period: 'FT' | 'FT_90'          // FT = including ET/pens where applicable
    anchor?: { seq: number, scoreP1: number, scoreP2: number }
              // claim-time state snapshot; REQUIRED for 'comeback'
              // (settlement is relative to the anchored deficit)
    trustTier: 'chain_proven' | 'oracle_resolved'   // derived, not LLM-chosen
  }
  ```

  The `anchor` field exists because a comeback claim is defined relative to the state when
  it was made ("we're losing and we turn this around"); anchoring the score and sequence
  number at claim time keeps settlement a pure function of spec + events.
- Non-compiling parses produce compiler-generated clarify questions or counter-offers
  (nearest valid spec); the LLM only phrases them. A monetary-forfeit deny-list runs at the
  same gate. The claimer confirm tap is mandatory before a market row exists.
- Claim-type priority: P0 = match_winner, totals_ou, team_scores_n; P1 = btts, comeback;
  P2 (stretch, go/no-go mid-build) = player_scores_n.
- **Player resolution pre-lineup** (accepted P2 limitation): `resolve_player` matches only
  against players already accumulated from previously-ingested knockout lineups (stable
  cross-fixture IDs + accumulated aliases). Unknown names take the story-14 decline path
  ("can't ground him yet — try me once lineups drop").

### Claim-type availability & staking windows

| Claim type | Mintable | Staking opens | Staking closes |
|---|---|---|---|
| match_winner | pre-match & in-play up to 75' | on confirm | earlier of freeze-then-settle or 85' |
| totals_ou | pre-match & in-play up to 75' | on confirm | earlier of freeze-then-settle or 85' |
| team_scores_n | pre-match & in-play up to 75' | on confirm | earlier of freeze-then-settle or 85' |
| btts | pre-match & in-play up to 75' | on confirm | earlier of freeze-then-settle or 85' |
| comeback | in-play only, while the claimed team trails | on confirm | 85' |
| player_scores_n | pre-match only | on confirm (or lineup activation) | kickoff |

In-play taps additionally pass the delay-arbitrage pending window (above). Tap-time price
locking is the primary fairness mechanism; the 85' cutoff is the backstop against
near-certain ×1.02 farming in stoppage time.

### Position rules

- Multiple taps per user per market are allowed up to the per-market stake cap; **each tap
  is its own position locked at its own price**.
- A user may not hold both sides of one market (second-side tap gets an ephemeral "pick a
  lane" answer). No side-switching, no cancellation once a tap clears its pending window.
- Insufficient-balance taps are rejected with an ephemeral callback answer showing current
  Rep.

### Rep economy & tunables (named constants in one shared config module — no magic numbers)

| Constant | Initial value |
|---|---|
| Starting balance | 1,000 Rep |
| Matchday top-up floor | 250 Rep, applied 08:00 UTC on any day with a covered fixture |
| Preset stakes | 25 / 50 / 100 Rep |
| Per-user per-market stake cap | 100 Rep |
| Multiplier clamp | ×1.02 – ×25 |
| Classifier thresholds (nudge / react) | 0.85 / 0.50 |
| Card re-price trigger | ≥ 5 percentage-point probability move |
| Card-edit collapse window | 1 edit per market per 60s |
| Persona generations cap | 20 per group per match |
| LLM budget | ~$1 per group per day, then trigger-only degradation |
| Settlement debounce | 90s initial; re-set from day-1 measured amend/VAR latencies |
| In-play tap pending window | measured feed delay + settlement debounce |
| Unconfirmed claim TTL (in-play) | 10 minutes |
| Morning slate send time | 09:00 UTC (fixed, v1 behavior) |

### Pricing

- Direct markets price from TxLINE demargined probabilities (`Pct`) at the relevant second;
  every quote pins the odds record's message ID + timestamp so the quoted price itself is
  provable via the odds-validation endpoint later.
- **Provenance labeling is truth-preserving per period semantics**: `FT_90` match_winner
  prices are "market" (StablePrice 1X2 is a 90-minute market). `FT` (including ET/pens)
  claims are "modelled" — the draw probability mass is split between advance outcomes by a
  fixed rule. Derived markets (team_scores_n, btts, player props) price via a
  bivariate-Poisson derivation calibrated to the live 1X2 + totals lines, labelled
  "modelled".
- **Pre-authorized fallback**: if bivariate calibration isn't converging by Jul 8, drop to
  independent Poisson (team-goal rates from the totals line split by 1X2 lean), still
  labelled "modelled". team_scores_n is P0 and the flagship demo claim — its pricing path
  must never block on the fancier model.
- Multipliers = 1/p clamped per the tunables; multipliers render in copy as "×9 Rep", never
  as odds notation.

### Settlement (the hard 20%)

- Event-sourced: every feed update is persisted with a `(fixtureId, seq)` uniqueness key
  (idempotent ingestion); settlement is a pure state machine consuming events in seq order.
- Market status machine:

  ```
  pending_lineup → open → frozen ⇄ open → settling → settled
                     ↘ voided (postponed/abandoned/coverage-lost/lineup-DNP)
  ```

  Freeze triggers: possible-event/VAR flags (immediate, no debounce), odds suspension,
  kickoff (for pre-match-only types), staking-close cutoffs per the availability table.
- Settlement fires only on `confirmed: true` events that survive the debounce window
  (constant above): an event settles when a higher-seq subsequent event arrives OR the
  debounce elapses, whichever is first, and amend/discard/VAR-end reversals within the
  window cancel it. Terminal phases (full time / after ET / after pens) settle whole-match
  types with `FT` vs `FT_90` semantics honored.
- Own goals count for team totals but never credit a player claim. Fixtures flagged with
  unreliable-coverage warnings auto-void affected market types with refunds.
- Rep accounting is an append-only ledger (stake / payout / refund / topup entries);
  balances are derived sums with a cached column for display. Ledger idempotency keys make
  double-taps and retries safe; deliberate multi-tap positions are distinct entries by
  design.
- **At-least-once chat delivery**: settlement and void rows carry a posted-at marker; an
  engine sweeper re-attempts Telegram delivery for any settled-but-unposted market, so a
  crash between settling and posting never silently eats a result.
- Chain proofs are an **async upgrade**: settle from the feed in seconds, then (after the
  publication batch closes) fetch the stat-validation Merkle proof, submit `validate_stat`
  from the server keypair, store the transaction signature, and flip the receipt badge via
  Realtime. Proof failure never blocks or reverses a settlement; it downgrades the badge
  label honestly.

### Ingestion & replay

- A single `MatchEventSource` interface with two implementations: **live** (SSE streams
  with Last-Event-ID resume persisted in a cursors table + snapshot gap-fill on reconnect)
  and **replay** (a virtual clock stepping point-in-time `asOf` snapshots at 10–30×).
  Replay exercises byte-for-byte the same downstream pipeline and doubles as the settlement
  regression harness. No recorded TxLINE payloads are ever committed to the repo (data
  license); replay always re-fetches with the runner's own credentials.
- **Replay semantics**: `/replay` is group-admin-only; one active replay per group; blocked
  while the group has open live markets; replay-minted markets are flagged, excluded from
  the season leaderboard and h2h records, and count against the group's daily LLM budget.
- Fixture discovery polls the fixtures snapshot on a 15-minute cron — knockout fixture IDs
  appear dynamically as the bracket resolves and must never be hardcoded.

### Telegram surface

- grammY with long polling; auto-retry + throttler plugins to absorb the ~20 msg/min
  per-group ceiling during goal bursts; card edits collapsed per the tunables. Inline
  keyboards carry the entire loop (nudge → make-him-prove-it → clarify → that's-my-shout →
  back/doubt → receipts). Message reactions (👀) are the low-noise acknowledgment channel.
- **Message-access model (corrected for how Telegram actually works)**: BotFather privacy
  mode stays **ON globally** — with privacy mode on, bots receive only commands, replies to
  their own messages, and @mentions. **Per-group always-on detection is enabled by
  promoting the bot to group admin** (admins receive all messages regardless of privacy
  mode); this promotion is the explicit, per-group, revocable consent lever and is
  disclosed in the intro message. The trigger path — reply `/bookit` to a claim, or mention
  `@CalledItBot` — is first-class and works in every group without admin. Plain-text "book
  it" replies work only in admin-enabled groups, as a convenience alias.
- Chattiness modes: default = priced-nudge. Settlement, void, and receipt messages post in
  all modes; narration and the morning slate post only in nudge mode; 👀 reactions occur in
  nudge and react-only modes; trigger-only mode suppresses both nudges and reactions.
- **Forfeit flow**: after "That's my shout", an optional "Add a forfeit?" step offers 6
  curated non-monetary one-liners as buttons (pack authored in a fixtures file). If the bot
  lacks pin rights the forfeit posts unpinned with a note. The forfeit message carries an
  admin-only **Honored ✅** button.
- Persona register is **game-show, not sportsbook** — a persona-safe glossary is enforced
  in templates and asserted in tests: "calls locked" not "staking frozen"; "Rep on the
  line" not "stakes/wager"; "×9 Rep" not odds notation ("11/1", "9-to-1"); no
  bankroll/bookie/betting-slip vocabulary; no currency symbols anywhere in consumer copy.
  This is a compliance/judging requirement, not a style preference.

### Web surface & privacy

- Group pages (leaderboard, receipts) live at **unguessable slugs**, linked only from
  inside the group's own chat — public-by-URL, private-by-obscurity. The intro message
  discloses web visibility; an admin command disables a group's web pages entirely
  (story 54). The judge demo group is explicitly public.
- The leaderboard page includes a **Hall of Calls** section: the group's top 5 settled
  receipts by multiplier. A read-only **replay viewer** page mirrors the demo group's
  replay in the browser so a zero-account judge sees the product *working*, not just its
  artifacts.
- **Data-license posture on public pages**: receipt pages display **derived facts only**
  (event type, minute, scorer name where applicable, seq references, confirmation status,
  settlement verdict) — never raw TxLINE payloads. Merkle proof bytes are fetched
  transiently for in-browser verification and are not persisted or re-served. "May receipt
  pages display per-event derived facts?" joins the week-1 TxODDS questions; a degradation
  plan (reduce evidence detail, keep verdicts) exists if the answer narrows.

### Identity, privacy, compliance

- Identity is the Telegram user ID asserted server-side by the bot; there is no auth
  system, no PII beyond Telegram display names, and no web login.
- Rep is non-purchasable, non-transferable, and worthless by construction; forfeits are
  non-monetary only (deny-list + curated packs). No jurisdiction/KYC machinery is needed
  because nothing of value is staked — this is the compliance architecture, keep it intact.
- No FIFA marks anywhere ("World Cup" as a factual tournament reference only, no logos).

## Testing Decisions

A good test exercises **external behavior through a stable interface** — feed events in,
market states/payouts/messages out — and never asserts on implementation internals. The
deterministic core exists precisely so the highest-risk logic is testable without Telegram,
Supabase, or the network. There is no prior art in this repo (greenfield); conventions set
here become the codebase's patterns. All code is written fresh in-repo during the hackathon
window (the "prototype" references above are design sketches from this project's own
planning documents, not prior code).

Modules under test, in priority order:

1. **market-engine settlement state machine** (highest value): given scripted seq-ordered
   event sequences → assert market status transitions, payouts, voids. Must include a
   golden suite of adversarial sequences: goal → VAR → discarded; goal → amend (scorer
   corrected); duplicate seq (idempotency); abandonment mid-match; extra-time and penalty
   phase semantics for `FT` vs `FT_90`; own-goal attribution; lineup DNP voids; comeback
   anchor semantics; delay-window tap voiding. Once live, augment with replay-derived
   sequences from real matches (fetched at test time with credentials, never committed).
2. **market-engine compiler**: valid/invalid MarketSpec matrix — every claim type × missing
   fixture, unknown player, monetary forfeit, out-of-range threshold, missing comeback
   anchor → assert compile results, clarify questions, and counter-offers (including
   chain-proven upgrade offers).
3. **agent parser golden set**: ≥50 real banter phrasings (including slang, typos, and
   non-claims that must be rejected) → assert compiled MarketSpec equality, not raw LLM
   text. Runs in CI against recorded expectations; gates deployment of any prompt change.
4. **persona vocabulary guard**: outbound template/copy tests assert the deny-listed
   sportsbook vocabulary never appears in any rendered consumer message.
5. **pricing**: demargined-Pct → multiplier math, clamps, Poisson derivations (and the
   independent-Poisson fallback) against hand-computed fixtures, "NA"/quarter-line
   handling, provenance labeling including the FT vs FT_90 rule.
6. **txline client**: zod schema parsing of captured-shape payloads (synthesized, not
   recorded), price scaling, cursor resume logic (simulated disconnects), asOf stepping.
7. **ledger**: append-only invariants — balance reconciliation, double-tap idempotency,
   refund-on-void completeness, delay-window void refunds.

The engine's Telegram handlers and the web pages get thin smoke coverage only; their logic
should be too shallow to break interestingly. End-to-end confidence comes from the replay
harness driving the full engine against a real finished fixture in a staging group — run
manually before each live-fire window, not in CI. Kill-9 recovery (cursor resume mid-match)
is tested deliberately before the first real group.

## Out of Scope

- Real-money or crypto wagering of any kind, user wallets, escrow, tokens, NFT/soulbound
  receipt mints, and any user-facing on-chain economy. (Solana appears only as the
  subscription + proof-verification layer.)
- Mainnet deployment (devnet decided; revisit only if the day-1 spike changes the network
  decision as a whole).
- Claim types beyond the six in the taxonomy: exact score, corners, cards, timing claims
  ("goal before 60'"), first/next scorer, tournament outrights, parlays/accas, multi-match
  claims.
- Cash-out / live position trading; user-set custom odds; custom stake amounts;
  side-switching or stake cancellation.
- Unprompted bot-initiated markets (the bot never mints without a human tap).
- Telegram Mini App; Telegram Login on web; any authenticated web state.
- Forfeit enforcement machinery beyond the flow specified (one pinned/posted line +
  settlement callout + admin Honored button).
- Rivalry instigation engine (auto-rematch nudges etc.) beyond leaderboard + h2h tallies.
- Group-vs-group play, public/global markets, DM mode, channels, multi-language,
  WhatsApp/Discord ports, voice/image claim detection.
- Moderation dashboards; web-based admin (in-chat admin commands only).
- Monetization implementation (billing). The commercial path IS evidenced (see Further
  Notes) but nothing is sold.

## Further Notes

- **Immovable calendar** (corrected against the verified schedule): Round-of-32 matches run
  through Jul 4; **Round of 16 ~Jul 4–7**; gap ~Jul 7–9; quarter-finals ~Jul 9–11;
  semi-finals ~Jul 14–15; bronze Jul 18; final Jul 19 (deadline day).
  - Jul 3–4: full TxLINE devnet spike (auth chain, data flow, proof roots, delay + amend
    latency measurement, odds inventory) **while R32/R16 matches are live**.
  - Jul 4–7 (R16): capture live feed observations, bank demo footage, and goal-burst-test
    the throttler — even though friend-group live-fire is scheduled for the QF window.
  - ~Jul 5 (**hard calendar item, not a note**): start the 28-day free on-chain
    subscription so the access window extends through the Jul 19–29 judging period.
  - Jul 7–9 (gap): heads-down build; core loop working by Jul 9.
  - Jul 9–11 (QF): live-fire in 2–3 real friend groups; capture story-53 metrics.
  - Jul 14–15 (SF): second live-fire; **feature freeze Jul 15**; outsider cold-test Jul 16.
  - Jul 17–18: demo video from replay + banked live footage; tech docs; TxLINE feedback
    write-up.
  - **Jul 19: submission mechanics only.** No product code.
- **Cut order under schedule pressure** (passive detection is the product's stated identity
  and an explicit user decision — it is protected): cut first: Hall of Calls, OG-image
  cards (fall back to text cards), morning slate, h2h display, forfeits; then P1 claim
  types (btts, comeback); then P2 (player claims — auto-cut if the core loop slips past
  Jul 11). Cut never: passive detection (minimal path = prefilter + classifier + nudge,
  no clarify flow), receipt pages + in-browser proof verification (the screening-judge
  path), replay mode, the settlement state machine.
- **Judge-window contingency**: before Jul 19, pre-run replays so the public demo group and
  web surface hold a complete settled corpus (claim → freeze → settle → proof) browsable
  with **zero API access**. Judge-triggered `/replay` is best-effort contingent on TxODDS
  confirming post-deadline access; the demo video plus the web corpus are the guaranteed
  evaluation path. **The submitted "live MVP" link is the public web surface** (zero
  accounts required, satisfying the judges-need-no-accounts rule), with the Telegram demo
  group link offered as the full experience.
- **Submission gates** (auto-disqualification risks): live publicly-accessible MVP link,
  ≤5-minute public demo video, public repo, no recorded TxLINE data in the repo, judges
  never need wallets/tokens/fees/accounts. The demo video is judged heavily — script it as
  a pitch: minting moment in the first 30 seconds; settlement receipt as climax; forfeit as
  the laugh; proof badge as the coda (with a signed-feed fallback beat if the devnet
  proof-root spike fails); **one 15–20 second monetization beat** (free groups → premium
  Club tier for creator/superfan communities → white-label for tipster channels, backed by
  story-53 numbers).
- **Tech docs** (required submission artifact): include the endpoint list actually used, a
  "business highlights" subsection carrying the monetization path, and the architecture
  sketch.
- **Week-1 questions to TxODDS** (Telegram/Discord, keep screenshots): API access through
  the Jul 19–29 judging window; devnet real-time tier existence; devnet proof-root
  publication cadence; whether small recorded payloads may ship in the repo (assume no);
  whether public receipt pages may display per-event derived facts (assume derived-only
  until answered).
- The required "TxLINE API feedback" submission field is genuinely valuable real estate:
  the day-1 empirical findings (odds-market inventory, price scaling, devnet quirks, delay
  measurements) are exactly what the sponsor wants to hear and cost nothing extra.
- No issue tracker is configured for this project yet. This PRD lives in the repo; when the
  public GitHub repo is created (submission requirement anyway), it should be filed as the
  root tracking issue with label `ready-for-agent`, and the module list above becomes the
  initial issue breakdown.
