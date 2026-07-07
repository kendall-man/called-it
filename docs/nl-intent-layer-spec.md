# Natural-Language Intent Layer — Spec (v2, hardened)

**Status:** proposed (2026-07-07). v2 folds in two adversarial reviews
(correctness + product). Supersedes v1.
**Goal:** let group members *talk* to the agent to run the whole bet cycle —
"make him prove it", "I'll back it 50", "nah I doubt that", "that's my shout" —
instead of tapping inline buttons, so it feels like one human running the book.

## Principle — conversation on top, determinism underneath

Poke feels human on the surface but is deterministic underneath (`display_draft`
→ confirm → typed tool execution). We copy that: **"LLM proposes, code
disposes"** stays.

- The NL layer only ever produces a **proposed action** (`intent + target +
  params`); it never mutates state.
- It routes proposals into the **existing deterministic handlers**, which own
  every validation and the settlement guarantees.
- Buttons remain first-class. NL is **additive** — unsure → silent → buttons
  still work. It can never be the *only* path.

The settlement-correctness the compiler + on-chain proofs give us is exactly
what makes conversational betting *safe to trust*.

## What v1 got wrong (corrections that shaped v2)

- ❌ v1: "unchanged handlers, just add a param." **False** — handlers report to
  the user *only* via `answerCallbackQuery`, which doesn't exist for a text
  message; a text-originated stake rejection (cap/balance/wrong-side) would fail
  **silently**. → Prerequisite **P2** (unify feedback behind `respond()`).
- ❌ v1 treated confirmation as money-grade for every stake. This is a **points**
  product (real money was hard-cut). Confirm guards *misparse*, not money loss →
  trigger it on ambiguity/magnitude, not universally.
- ❌ v1 was a *routing* spec with no *voice*. The "feels human" magic is the
  voice + the addressing model → new **Agent Voice** and **Addressing** sections.
- ✅ v1's spine was right: closed taxonomy, no generic "do anything" tool,
  shared lock, confirm scoped to precision-risk, the raw-amount refactor.
- Cut from v1: `cashout` (real-money/withdraw was hard-cut), the model-escalation
  tier, the rollout machinery, and the over-grounded `ActionContext`.

## Prerequisites (must land before NL is safe — do NOT skip)

| # | Prereq | Status | Why |
|---|---|---|---|
| **P1** | Per-`(market,user)` stake lock + positive-integer amount guard | **DONE** (`callbacks.ts` `withStakeLock`; commit 5c448a9) | Stops double-stake TOCTOU; a negative/NaN amount would credit Rep. NL adds a 2nd concurrent channel — this is load-bearing. |
| **P2** | Unify handler user-feedback behind a `respond(ctx,text)` that posts a **reply** when there's no callback query | TODO | Reused handlers today only `answerCallbackQuery`; text actions would fail silently. Refactor `answer()` → `respond()`; all stake/prove/confirm acks + rejections flow through it. |
| **P3** | Persisted **bot-card → target** index (nudge card, gate card, market card message ids) | TODO | Reply-to addressing (the spine, below) needs to map a replied-to bot message → claim/market. Today only `claim.tg_message_id` (the *user's* original msg) is queryable; card ids aren't. |
| **P4** | Separate LLM **budget bucket** for intent (distinct from passive-detection cap) | TODO | Else cue-word spam exhausts the group's daily allowance and silently disables claim detection — the core identity. |
| **P5** | Arbitrary-amount stake path: `handleStake` takes a validated `amount` | TODO | Conversational stakes are arbitrary ("put me down 30"). Keep the codec on `presetIndex` (convert at dispatch); an inline-confirm button carrying an amount needs a **new** codec branch — the `st:` field is single-digit `\d`. Land handler tests first (**DONE** for the current path). |

## Architecture

```
message:text  (grammY middleware — MUST call next() on fall-through, R6)
   │
   ▼
[A] addressing + cheap gate:
    is this message ADDRESSED to the agent AND is there a live target?
    (reply-to a bot card  OR  @mention  OR  conservative lexical cue + number)
        └─ no ───────────────────────────────────────────────► fall through
   ▼ yes                                                        to claim-detection
[B] assemble slim ActionContext (open claims+markets, reply-to ref)
   ▼
[C] classifyIntent(text, ctx)  → @calledit/agent  (glm-4.5-air, one call,
    forced closed-taxonomy tool output)  → { intent, targetRef, params, conf }
        └─ intent=none OR conf<floor ───────────────────────────► fall through
   ▼
[D] resolve target deterministically + re-verify targetRef ∈ this group's
    live list (never trust the model's id; C2/R3)
   ▼
[E] precision-risky? (arbitrary amount, or fuzzy option, or destructive
    claimer-only intent)  → draft + single-use owner-scoped confirm
    else → straight through
   ▼
[F] route to the EXISTING handler under the shared lock, via a text-aware
    `respond()`  (handleStake / handleProve / handleConfirm / …)
```

`[A]`→`[F]` live in `apps/engine/src/bot/intent.ts`; `[C]` is a new capability
in `packages/agent`.

## Addressing model (the spine — this is what makes it feel like Poke)

In Poke, *everything you say is addressed to Poke*. The group-chat equivalent
is explicit addressing. **Priority order for "is this to the agent?":**

1. **Reply-to a bot card** (needs P3) — strongest, unambiguous.
2. **@mention** the bot — explicit.
3. **Bare lexical + number, conservative** — e.g. "put me down 30 on France"
   while a market is open. This is the real magic (no hunting for a card) *and*
   the highest false-positive risk, so v1 keeps it **narrow**: require a
   stake **number** + entity/side match + high confidence; never fire on bare
   "I'm in" / "prove it" without a target match.

Reply-to/@mention are the **default** addressing signals; the bare-lexical path
is opt-in and tight. This single decision kills most false positives.

## Intent taxonomy (closed set, 1:1 with the buttons)

| intent | handler | claimer-only | needs amount | needs target |
|---|---|---|---|---|
| `prove` | handleProve | no | no | a `detected`/`nudged` claim |
| `pick_option` | handleOption | yes | no | a `clarifying` claim + option |
| `confirm` | handleConfirm | yes | no | an `awaiting_confirm` claim |
| `decline` | handleDecline | yes | no | claimer's live claim |
| `back` / `doubt` | handleStake | no | yes | an `open` market |
| `none` | ignore silently | — | — | — |

No `cashout` (real-money/withdraw was hard-cut). No generic action — the
taxonomy *is* the guardrail.

## [B] ActionContext (slim — only what's needed to classify)

```ts
interface ActionContext {
  speakerId: number;                 // ctx.from.id (attribution, NOT grounding)
  replyToCardRef?: TargetRef;        // from P3
  openClaims: Array<{ id; status; entityNames }>;   // no quotedText passed raw
  openMarkets: Array<{ id; entityNames; side_taken_by_speaker? }>;
}
```

Dropped from v1: `balance`, `cap`, `presets`, `speakerIsClaimer` — the handler
already owns claimer-only/cap/balance and disposes accordingly; passing them to
the LLM is over-grounding. User-authored text (claim text, entity names) is
**delimited as untrusted** in the prompt (R3), and `[D]` re-verifies any
returned id against the live list — the model's confidence never alone clears
the floor for a destructive intent.

## [C] `classifyIntent` — new `@calledit/agent` capability

`packages/agent/src/intent.ts`, same shape as `classify.ts` (injectable
`AgentModelClient`, forced tool output, deny-list clean). Signature:
`classifyIntent(text, ctx): Promise<ActionIntent>` where
`ActionIntent = { intent, targetRef, params:{amount?,optionHint?,entityHint?}, confidence }`.
Model **`glm-4.5-air`**, one call, **no escalation tier in v1** (v1 targets are
deterministic — reply-to / sole-open — so there's nothing to escalate for).
System prompt: enumerate the closed set + the group's live targets; DEFAULT to
`none`; parse amount as a plain integer; negation/sarcasm → `none` or the
correct opposite side.

## [D] Target resolution (deterministic)

1. **reply-to** card → that target.
2. **named entity** matching exactly one open target.
3. **sole open target** — *but* **never** default when the message contains a
   fresh claimable entity that does **not** match the open target's
   `entityNames` (C2: "Ronaldo hat-trick, I'm on it 30" with one open *Messi*
   market must NOT stake Messi and eat the Ronaldo claim → require entity/reply
   match for `back`/`doubt`, else fall through to the claim path).
4. **ambiguous** (≥2 candidates) → one-line clarify (buttons offered as the
   fast answer).
5. **no valid target** → silent `none`.
Always re-check `targetRef.id ∈` this group's open list before routing (R3);
handlers also re-check `group_id === chatId` (cross-group already blocked).

## [E] Confirmation — points-appropriate, single-use, owner-scoped

Confirm **only where free text risks a wrong action**, not every stake:
- **Arbitrary/large amount** (relative to balance) or a **parse-ambiguous**
  amount ("2.5", "50k", "a hundred") → draft + confirm.
- **Small routine stake** with a clean integer → route straight through (feels
  human, not ceremonial).
- **Claimer-only destructive** (`decline`, `confirm`-mint) via bare lexical →
  require reply-to + a higher confidence floor (R4: `decline` is terminal,
  `confirm` mints — neither is undo-by-retap).

Draft rules (C3, the injection/replay surface):
- Draft key = `(speakerId, marketId)`; **single-use** (deleted atomically on
  confirm — repeated "yes" must not stack stakes).
- Confirm requires the "yes"/👍 to **reply to the draft card** AND
  `ctx.from.id === draft.speakerId` (a bare "yes" in chat must not fire; user B
  cannot confirm user A's draft).
- With ≥2 live drafts, a reply must resolve which — never guess.
- The draft **re-runs the full handler** on confirm; it never caches a
  pre-authorised stake (N3 — so a market that settles between draft and confirm
  is rejected safely by the handler's status re-read).
- **Hybrid (recommended, open-Q resolved → yes):** put a one-tap **👍 confirm
  button** on the draft. Collapses NL+confirm to type-once + tap-once — the best
  of both, exactly like Poke keeps a confirm affordance. (Emoji-*reaction*
  confirm is v2 — it needs a `message_reaction` update subscription the bot
  doesn't have today, R7.)

## Agent voice (the "feels human" half — copy through `say()`/deny-list)

New template keys in `bot/copy.ts`, rendered via the existing `say()`/`persona()`
+ deny-list (no odds notation like "11/1", no bet/wager/stake/bookie words, no
currency symbols, game-show register). It must sound like a friend, **not a
receipt**:

| key | robotic ❌ | in-character ✅ |
|---|---|---|
| `intent_stake_draft` | "Locking you in — Back Messi ×2.5 for 50 Rep. 👍 to send it." | "50 on Messi's brace? bold. 👍 and you're on the record." |
| `intent_stake_locked` | "Position placed." | "You're in — 50 riding on the little man." |
| `intent_clarify_target` | "Ambiguous market. Specify one." | "which shout — Messi's brace or United to win?" |
| `intent_confirmed` | "Claim confirmed." | "that's your shout then. it's live." |
| `intent_near_miss` | (silence) | *(v2)* "you trying to get on this? say the word." |

Voice is priority #1 for the vision: a correct router that talks like a form
does not feel like Poke. Reuse `persona()` variant selection so it isn't
same-y.

## Concurrency, safety, noise

- **Lock:** reuse `withStakeLock` (P1) — shared with the button path so a tap +
  a text can't double-stake. `withClaimLock` for prove/option/confirm/decline.
- **Attribution:** route with the *real* `ctx.from.id` (N4 — the one invariant
  that survived review: you can't stake *as* someone by naming them).
- **Budget:** separate bucket (P4); no escalation to double-charge.
- **Noise (the #1 UX risk — bot back-seat-quoting banter):** hard gate `[A]`
  (addressed + live target), high confidence floor, **bias to silence** — a
  missed bet is recoverable (tap the button); a phantom bet is not. During a
  goal, the bare-lexical path must be especially conservative.
- **Middleware (R6):** register the intent handler so it `next()`s on
  fall-through, or claim-detection silently dies.

## Testing

- **Money-path handler tests** (`callbacks.stake.test.ts`) — **DONE**: single
  stake, concurrent double-stake → one position, one-side, cap, balance. These
  are the regression net the P5 amount refactor must keep green.
- **Intent golden set** (`intent.golden.test.ts`, mirrors the claim golden set):
  positives per intent + **adversarial must-not-fire** (negation, sarcasm,
  hypotheticals, third-party chatter, unrelated numbers). Assert compiled
  action equality, not raw text. Scripted `AgentModelClient` in CI; `AGENT_LIVE`
  gated live runs.
- **Engine flow:** NL back → one position; tap+text → one position; claimer-only
  intents reject non-claimers; C2 (fresh entity → claim path, not a stake); C3
  (cross-user confirm rejected; repeat "yes" doesn't stack); silent-`none`
  `next()`s to detection.

## Phasing

- **v1 (timeboxed):** P1(done)+P2+P3+P4+P5, then `back`/`doubt` (amount +
  points-appropriate confirm + 👍 button) and `prove`/`confirm` via NL,
  reply-to/@mention addressing spine, conservative bare-lexical, voice keys.
  Buttons untouched.
- **v2:** multi-market disambiguation, corrections ("no wait, make it 100"),
  `pick_option`/`decline` via NL, near-miss repair, reaction-confirm.
- **Never:** free-form actions outside the closed taxonomy.

## Strategic sequencing (read this before building)

NL betting is **Fan-UX/Originality upside, not the core wow** — settlement +
the Chain-proven receipt is. That core is already banked (settled live +
on-chain proof). So investing here is defensible — but:
- **Buttons stay the demo-safe spine.** Never put a live LLM on the critical
  path of the demo video — a misfire on stage is worse than a button that
  always works. Show NL as the "oh, you just *talk* to it" beat, with buttons
  as the fallback.
- **Timebox it.** Do the prerequisites (P2–P5) first — they're where the real
  work and risk are — and cut NL cleanly if it isn't rock-solid.

## v1 demo script (replay mode, a real finished match)

1. **Talk mints it:** *"France are scoring two today, easy"* → bot 👀 → someone
   taps **Make him prove it** → priced Claim Card.
2. **Talk confirms it:** claimer types *"yeah that's my shout"* (NL confirm, no
   button) → market live.
3. **Talk bets it:** *"go on, put me down 30 on France"* → in-voice draft
   *"30 on France 2+ at ×3 — 👍 to lock"* → tap 👍 → *"you're in."* (arbitrary
   amount a preset can't do).
4. **Settles before the TV would:** replay fast-forwards → 2nd goal → instant
   receipt, Rep paid, **Chain-proven ✓** flips live on the web page.
5. **It knows when to shut up:** *"haha no way, I doubt that"* as banter → bot
   stays silent. The restraint is the feature.
