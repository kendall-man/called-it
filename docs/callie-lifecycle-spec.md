# Callie single-message two-step-stake lifecycle — build spec (2026-07-18)

Source: behavioral-econ + eve/GLM + code-synthesis research (workflow wf_94bb6e7e-09e).
Grounding docs: docs/callie-ux-overhaul.md, DESIGN.md, CONTRACTS.md.

## Product intent
Collapse a claim's whole lifecycle into ONE evolving Telegram message ("first message
= last message until the board"), with a two-step stake: pick SIDE, then pick VALUE from
a small ladder, with lossless back-navigation until the explicit Mini App signature.
Richer LLM-proposed clarify options (compiler-validated). Feels "fluid as liquid."

## Behavioral-econ decisions (ethical levers only — all clarity, no pressure)
- Two steps, not one 8-button grid: step 1 = 2 side buttons, step 2 = value ladder + Back.
  Rationale: Hick-Hyman + choice-overload (Chernev 2015) — never force side×amount at once.
- Ladder = ascending exact SOL `0.01 / 0.02 / 0.05 (/ 0.1)`, 1-2-5 series. 3 rungs in
  escrow (on-chain devnet cap 0.05), 4 in legacy. Never more than 4.
- 0.01 is the anchor: leftmost, named "base stake" in copy — but NEVER preselected, and
  NO SOL moves until the sign. (Goswami & Urminsky low-anchor lifts participation.)
- Discrete buttons, not a slider (Funke 2016; and Telegram can't render a real slider; a
  −/+ stepper adds an API round-trip per tick and a covert start-anchor).
- Endowed progress with REAL steps: after side pick the card shows "Priced ✓ / Side ✓ /
  Stake: choose". Peak-end: invest design budget in the settlement board (the "end").
- Reversibility: full Back while composing (SDT autonomy lowers first-tap anxiety); hard
  finality only at signature. The two-step tap is "positive friction" (responsible-play).
- Dark-pattern taxonomy (Mathur et al.) maps 1:1 onto what the honesty contract already
  bans: no MAX button, no %-of-wallet, no countdown pressure, no winner hype, no re-stake
  prompt at settlement.

## State machine (one canonical message id per claim)
1. awaiting_consent — `🎙 THE CALL` + quote + claimer + "confirm this is your call…";
   KB [Confirm cf] [Decline nx].
2. clarifying — compiler question + ≤3 option rows (op:<claimId>:<key>) + [None of these]
   (op:…:no); owner-only (existing handleOption guard).
3. pricing — skeleton "Pricing this call off the live feed…" (no KB).
4. offer_open — full card + 2 side buttons (callback st:, contextual labels, NO amount).
5. value_pick — same message edits to the ladder: header names the side, rungs
   (sv:<market>:<side>:<code>) + [← Back sb:<market>]. Body: "0.01 is the base stake.
   Nothing moves until you sign."
6. sign_handoff (escrow) — one URL button "Review & sign <amount> for <side>" →
   t.me/<bot>/app?startapp=p-<hex32>-<b|d>-<amountCode> + [← Back].
7. frozen/settling — existing statuses; fair-play delay = FAIR_PLAY_PENDING_LINE.
8. settled_board — FINAL edit of the same message (outcome, one evidence line, per-person
   exact SOL deltas, receipt link) PLUS one compact ping (reply to the card) — the only
   new message, justified: edits emit no notification and settlement is the one genuinely
   new event. At-least-once stays on the ping (markSettlementPosted + sweeper).

## Two-step semantics
- Keep the `st` callback codec byte-for-byte (zero conflict with the labels agent).
- With the ladder flag ON, handleStake no longer mints a session; it sets ui=ladder(side,
  20s TTL), urgent-edits the card, toasts "<side> picked. Size the stake below."
- New `sv` handler: reuse handleStake guards; map code→lamports; replay→placeReplayPosition,
  legacy→wager stake, escrow→ui=sign(side,code,30s TTL) + urgent edit.
- Shared surface (market-scoped, not user-locked): any user's rung tap honored; any user
  may tap the sign URL (encodes only public side+amount; identity from their own initData).
  Auto-revert timers (20s/30s) + lazy revert on later taps keep the surface unstuck.
  UiStateStore in-process keyed by marketId; restart loses only the visual.

## startapp + session amount contract
- Extend to `p-<hex32>-<b|d>-<amountCode>`, amountCode ∈ {1,2,5,10} = base units of 0.01
  SOL (≤39 chars, [A-Za-z0-9_-], no secret). Web pattern
  `/^p-([0-9a-f]{32})-([bd])(?:-(1|2|5|10))?$/`, absent → 1 (backward compatible with every
  already-posted card). Include amountCode in the idempotency-key recipe; forward to engine.
- Engine `EscrowPositionSessionInputSchema`: accept BOTH legacy `amountPreset:0` and new
  `amountCode` during rollout skew (deploy engine before web); map code→lamports via shared
  helper; keep the 0.05 devnet cap enforcement.

## Ladder constants + caps
`wager/constants.ts`: `STAKE_LADDER_BASE_UNITS = [1,2,5,10]`, `ladderLamports(code)=code*10_000_000n`,
`stakeLadder(asset,custody,network)` filters rungs above the effective max (escrow devnet
0.05 → 3 rungs; legacy → 4 within PER_MARKET_STAKE_CAP 0.1).

## Clarify enrichment (LLM proposes, compiler disposes)
Extend parseClaim to return ≤3 candidate interpretations on glm-5.2; compile EACH through
compileClaim; keep only kind:'ok' + the compiler's own clarify/counter_offer options; dedupe
by spec identity; cap 3; label every button from describeTerms (numbers NEVER from LLM text);
append "None of these" (op key 'no'). CONTRACTS.md packages/agent rule preserved.

## Edit pipeline
`SendQueue.enqueueCardEdit` gains `{urgent?:boolean}`: urgent cancels deferred edit for the
key and unshifts ahead of narration; passive edits keep the 60s collapse (do NOT lower it
globally). ONE `renderCardSurface(deps, market, uiState)` is the sole producer of surface
text+KB for states 4-7 (callbacks, settler refresh, projection sink) so a deferred passive
edit re-renders the active ladder instead of stomping it.

## Copy rules (labels agent owns fallback-copy.ts / wager/copy.ts)
Facilitator voice; no urgency/social-pressure/hype; no re-stake prompt at settlement; zero
exclamation marks in money lines; "← Back" no suffix; value body names 0.01 "base stake"
(anchor by position + copy, never preselection). Per product-voice-no-nag: devnet disclosed
ONCE (onboarding + receipt), NOT stamped on every card.

## Ordered task list
T1 wager/constants.ts ladder consts+tests [new exports; not in labels set].
T2 callbackData.ts sv/sb kinds encode+decode+round-trip [append-only].
T3 bot/stake-ui-state.ts UiStateStore {get/set/clear, ttl, onExpire}+tests [new].
T4 sendQueue.ts+poster.ts urgent option+ordering tests [append-only].
T5 bot/stake-step-cards.ts progress block/value body/sign body/board/ping [new; imports
   sideLabels/describeTerms read-only].
T6 bot/stake-step-keyboards.ts ladder+sign+back KBs [new].
T7 migration 00XX_claim_surface: claims.surface_tg_message_id + facade setter.
T8 offer.ts posts the surface at claim commit, onSent persists id; confirm gate + options
   become edits; skeleton edits the surface; mint calls setMarketCardMessage(surface id).
T9 callbacks.ts handleStake→ladder; new sv/sb handlers; toasts-before-edit.
T10 web: startapp amountCode pattern+idempotency+forward; miniapp-server amount.
T11 engine EscrowPositionSessionInputSchema amountCode union + code→lamports.
T12 renderCardSurface unifies states 4-7; wire callbacks/settler/projection.
T13 RENDEZVOUS (LAST, after labels agent commits): fold amount-aware startParam into
    keyboards.ts miniAppStartParam; route offerKeyboard/marketStakeKeyboard call sites
    through renderCardSurface.
T14 full engine+web suites green; verify:product-copy; eve:build.

## Composition rule
Labels agent owns keyboards.ts, cards.ts, fallback-copy.ts, wager/copy.ts, keyboards.test.ts.
This wave touches NONE of those until the labels work lands; new logic goes in the new files;
codec/queue changes are append-only; the two rendezvous edits (T13) run LAST.

## Model + framework (do now, before 2026-07-19)
- GLM-5.2 is real: id `glm-5.2` on https://api.z.ai/api/anthropic, 1M context, released
  2026-06-13. Swap: agent.ts `glm-4.6`→`glm-5.2` + `200_000`→`1_000_000`;
  packages/agent/src/constants.ts PARSER_MODEL `glm-4.6`→`glm-5.2`. KEEP glm-4.5-air for
  classifier + persona garnish (per-message, latency/cost-critical, ~7x cheaper). Optional:
  GLM_PARSER_MODEL env override for one-env-change rollback. Validate with AGENT_LIVE=1
  golden set once.
- eve: bump in-range to 0.22.6 now (approval-resume persistence fix, zero code change).
  DEFER 0.23→0.25 until after the deadline (0.23 removes limits.maxSubagentDepth which
  agent.ts sets; 0.24/0.25 reshape the HITL resume path the team hand-patched).

## ChatSDK-over-eve integration (Vercel Chat SDK)
- PROVEN viable: eve@0.22.4's bundled chat typechecks against @chat-adapter/telegram@4.34.0
  + @chat-adapter/state-memory@4.34.0 (both installed). `chatSdkChannel({adapters:{telegram:
  createTelegramAdapter()}, state: createMemoryState(), streaming:true, streamingEditIntervalMs:1000})`
  constructs and `.send()` typechecks.
- Rich path: post-then-edit token streaming (thread.post → adapter.editMessage, 1s throttle),
  MarkdownV2 cards, typing (thread.startTyping), reactions, HITL as Cards (auto onAction).
- Single-ingress preserved via SPLIT WEBHOOK: the Telegram webhook front door stays the
  native concierge path that FORWARDS group/command/callback updates to the engine; only
  conversational-private updates are handed into the chatSdkChannel route (loopback) so
  eve's webhook context (ActiveWebhookKey) is set and `send`/streaming work. Reason: the
  Chat SDK routes by subscription/mention and would DROP plain group /commands, breaking
  engine claim detection — so it must not be the sole front door.
- Auth: build the `telegram-webhook` principal telegramIdentity expects —
  `{ current: { authenticator:'telegram-webhook', attributes:{ chat_id, user_id, username } } }`.
- Go-live requires unifying the concierge TELEGRAM_BOT_TOKEN with the engine's (@callit_testing_bot)
  and pointing the webhook at the concierge — deliberate, separate, verified step.
