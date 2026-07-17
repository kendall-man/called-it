# PRD: Called It Direct SOL Beta

**Status:** product contract locked for implementation

**Network:** Solana devnet only

**Primary surface:** one Called It Telegram bot in a football group

**Supporting surfaces:** private account, aggregate group board, public receipts, Eve
concierge

## 1. Product Definition

Called It turns a specific football claim in a Telegram group into a two-sided, peer-matched
test-SOL position. The deterministic engine compiles the terms, prices them from TxLINE,
settles from feed events, refunds unmatched SOL, and publishes an aggregate receipt with the
proof state it can actually support.

The product has one current economy: SOL/test SOL on Solana devnet. Test SOL has no monetary
value. The beta does not support mainnet, fiat, product fees, a points balance, or claims of
profit.

### Product promise

One real add-to-group action leads directly to one ready group, one consented live call, and
one 0.01 SOL side choice. Installation is setup and the live offer is onboarding.

### Non-goals

- No demo or replay onboarding, tutorial market, fake participant, fake liquidity, scripted
  result, or prerecorded product state.
- No wallet-first landing flow, raw wallet-address linking, mainnet, fiat, custom odds, or
  fees.
- No real-value claim.
- No public identity, wallet, private balance, individual position, raw chat, or private
  ledger access.
- No public points leaderboard or alternate economy.
- No model-authored price, market terms, balance, position, settlement, or proof result.

## 2. Users And Jobs

### Installing admin

- Add Called It to an existing group with one action.
- Grant only the minimum `manage_chat` admin right needed for the beta.
- Receive one ready message, not a checklist or wizard.
- Understand that test SOL has no monetary value before a position can be placed.

### Speaker

- Put a football claim on the record intentionally.
- Confirm or decline a call inferred from passive chat before any offer is published.
- See deterministic terms and know exactly when the call settles.

### Participant

- Pick `It happens` or `It does not` in one tap.
- Know the exact SOL amount, committed/pending/matched state, and refund behavior.
- Recover privately when wallet setup, funding, identity, or market state blocks the action.

### Viewer

- Open a group board or receipt without login.
- Verify compiled terms, aggregate SOL, outcome, and proof without learning who a Telegram
  user or wallet owner is.

## 3. Direct Journey

### 3.1 Entry and installation

The landing page has one dominant **Add to Telegram group** action. Its production URL is:

```text
https://t.me/<bot>?startgroup=calledit_v1&admin=manage_chat
```

The bot handles Telegram membership updates and the versioned group start idempotently. It
persists the group/admin state and posts one short ready message for onboarding version
`calledit_v1`. Duplicate updates never create another ready post.

The ready message contains:

1. One example explicit football call.
2. A plain explanation of the happens/does-not choices.
3. The test-SOL no-monetary-value notice.
4. One next action.

Once the ready marker and message are committed, the system emits `group_ready` exactly
once.

### 3.2 Speaker consent

A call is explicit only when the speaker:

- mentions the bot with the claim;
- invokes `/bookit` on their own message; or
- uses an equivalent direct command bound to their trusted Telegram identity.

An explicit call can proceed immediately to clarify, compile, price, and offer.

Passive detection or a different member's `/bookit` creates an owner-only
`awaiting_confirm` state with **Confirm** and **Decline** actions and a two-minute expiry.
Only the original speaker can confirm. Before confirmation there is no market, public quote,
receipt, or publication of the raw words. Decline, expiry, unauthorized confirmation, and
duplicate callbacks create no market.

Clarification and deterministic counter-offers remain available after consent. A model may
propose a parse, but the compiler owns the accepted taxonomy, timing, and settlement terms.

### 3.3 Offer

Every default SOL offer shows deterministic compiled terms and exactly these top-level
labels:

1. `It happens · 0.01 SOL`
2. `It does not · 0.01 SOL`
3. `Choose amount`

The first two actions commit the default side and amount without another confirmation
screen. `Choose amount` opens a requester-scoped 0.05/0.10 SOL side picker. That picker is
unusable by other members and expires or disables after two minutes or one successful use.

No `Back`, `Doubt`, odds notation, multiplier-as-payout copy, or six-button amount grid is a
primary offer contract.

### 3.4 First position and starter grant

The default amount is 10,000,000 lamports (0.01 SOL). When all independent rollout switches
allow it, a user with no prior wager ledger or position history may receive one starter
grant for this exact first position.

The database operation must atomically:

1. validate trusted identity, idempotency, market, side, amount, cap, pause, and global
   budget;
2. create one 10,000,000-lamport starter credit;
3. spend the same amount into one position; and
4. record the grant and position before returning success.

There is no grant without a position and no partially consumed grant. The global budget is
disabled by default and capped at 5,000,000,000 lamports or 500 grants, whichever comes
first. A second tap, ineligible identity, disabled switch, or exhausted budget creates no
partial balance change and returns one recovery action.

The starter grant has no monetary value, is not a separate reward, and is not guaranteed.
Never call starter funds practice, demo, or free money.

After a position is committed, the system emits `position_placed` exactly once for its
idempotency key.

### 3.5 Larger positions and account recovery

A funded, verified user can place an allowed 0.05/0.10 SOL choice directly. If identity or
funding is missing, the engine preserves one immutable pending intent bound to user, group,
market, side, amount, and expiry, then sends the member to the private account Mini App.

The account flow validates Telegram Mini App identity and a Solana devnet wallet signature.
Funding never places a position automatically. The member must explicitly confirm the same
preserved intent after funding. Expiry, changed terms, a closed market, wrong network,
wrong user, or a conflicting active intent fails without a position.

## 4. Commands And Navigation

Private commands:

| Command | Contract |
| --- | --- |
| `/start` | Add-to-group and private account actions |
| `/me` | Requester's test-SOL balance, verified wallet state, positions, receipts |
| `/wallet` | Verified Solana devnet account flow |
| `/help` | Only implemented private commands |

Group commands:

| Command | Contract |
| --- | --- |
| `/bookit` | Speaker-owned explicit call submission |
| `/table` | Current group's aggregate SOL board |
| `/help` | Only implemented group commands |

Calling `/me` in a group returns a private deep link and never account fields. Calling
`/table` outside a group explains that the board belongs to a group and gives one next
action. Every advertised command has a handler and a non-placeholder destination.

## 5. Money And Settlement Rules

- One side per user per market; no silent side switching.
- Per-user per-market cap: 0.10 SOL.
- Default/picker amounts: 0.01, 0.05, and 0.10 SOL only.
- Positions are peer-matched at the deterministic feed-derived price.
- Unmatched SOL is not exposed to the outcome and is refunded at settlement.
- Winners receive their matched principal plus a pro-rata share of the matched opposing
  pot. The product charges no fee.
- In-play positions use the fairness delay and late-match cutoff defined by the pure market
  engine. A feed event that predates a pending tap can void that tap.
- Duplicate Telegram delivery or durable-worker replay returns the original outcome and
  never duplicates a grant, position, settlement, refund, payout, post, or event.
- Solvency, pause, closed market, ambiguous period, feed outage, and unavailable proof fail
  closed for new positions without blocking refunds or recovery.

## 6. Group Board, Account, And Receipt

### `/table`: shared group board

The board is for scanning group state, not ranking people. It shows active calls,
deterministic compiled terms, happens/does-not aggregate pots, matched amount, state,
close/settlement timing, and recent receipts. It contains no personal balance or individual
position.

### `/me`: private account

The account shows only the authenticated member's test-SOL balance, verified wallet state,
pending intent, and open/pending/settled positions with receipt links. Group chat never
receives those fields.

### Public receipt

A public receipt contains:

- the confirmed speaker's random stable per-group alias;
- terms rendered from `market.spec` by deterministic code;
- outcome, happens/does-not pots, matched total, refund, payout, and participant count;
- settlement and proof state with explorer/verification details when available; and
- a link back to the aggregate group board.

Raw `claims.quoted_text` remains private. Public data never includes Telegram IDs, names,
usernames, wallet addresses, balances, individual positions, deposits, withdrawals, raw
messages, or unbounded analytics text.

Aliases are random, nonempty, stable within a group, unique within that group, and may be
different for the same user in another group.

## 7. Proof Contract

Every offer and receipt discloses one trust tier:

- **Chain-proven:** a supported team-stat settlement has proof bytes that verify against the
  TxLINE root published on Solana devnet.
- **Oracle-resolved:** the deterministic result comes from the signed feed but the stat is
  not supported by the on-chain tree.

Proof submission is asynchronous and never changes a settled outcome. The UI must represent
pending, verified, unavailable, and failed states honestly. It cannot show a success badge
from a transaction signature alone or hide an unavailable proof behind optimistic copy.

## 8. Concierge Contract

Eve/Callie is an addressed conversational layer over the same deterministic engine. It may
list live calls, explain rules, quote a claim, read the trusted requester's account state,
and request a position through allowlisted tools. It cannot invent numbers, derive identity
from model text, publish an unconfirmed passive claim, write Supabase, or declare a mutation
successful without the engine's committed result.

The bot keeps short football personality after the status and next action. Conversation is
not a separate onboarding path and never advertises a simulated flow.

## 9. Recovery And Accessibility

Every failure states:

1. what happened;
2. whether SOL or saved state changed; and
3. one next action.

If commit state is uncertain, say it is being checked; do not tell the user to tap again.
If nothing changed, say so. Preserve a safe pending intent across reload or interruption.

All product surfaces follow `DESIGN.md`: one `h1`, ordered headings, at least 14px critical
text, zero negative letter spacing, visible 3:1 focus, 44px targets, keyboard completion,
announced asynchronous states, reduced-motion behavior, and no horizontal page scroll at
320px or 200% text zoom. Status never relies on color, animation, emoji, or toast alone.

## 10. Activation And Telemetry

Only these events count as activation:

| Event | Emission point |
| --- | --- |
| `group_ready` | One group-ready marker and message have committed |
| `position_placed` | One valid position has committed |

Other onboarding events may measure the funnel, but they do not redefine activation. Event
payloads use allowlisted reason/role/source fields and HMAC-pseudonymous actor/group IDs.
They never contain message text, raw Telegram identity, wallet addresses, network
credentials, IP addresses, or signatures.

## 11. Architecture Boundaries

- `@calledit/market-engine` stays pure: deterministic compile, price, reduce, and evaluate;
  no I/O, environment, clock, model, or database access.
- The engine is the single writer and owns Telegram mutations, claim/position guards,
  settlement, proof work, and idempotency.
- The concierge talks only to the private engine API and imports no workspace package.
- Browser code reaches account/event mutations only through same-origin server routes. It
  never receives engine or service-role credentials and never writes Supabase directly.
- Public web queries read only curated aggregate views. Notifications invalidate and refetch
  those views; they are not trusted as complete public records.
- Durable queues and ledger/database rows, not process memory or logs, are the source of
  truth for retryable work and money state.

## 12. Product Acceptance

A release candidate is not ready unless automated scenarios prove:

- one add action produces one ready group and one `group_ready` event;
- explicit calls proceed, passive/friend calls wait for speaker consent, and unauthorized or
  expired confirmation creates no market;
- offer snapshots contain the three exact labels;
- one eligible first 0.01 SOL tap creates one grant and one position with one
  `position_placed` event; duplicate delivery creates no additional effect;
- disabled/exhausted starter, insufficient funds, paused/closed market, and wrong identity
  return the recovery contract with no partial write;
- `/me` remains private and `/table` remains aggregate;
- public JSON and rendered pages contain aliases and compiled terms but no raw quote or
  forbidden identity fields;
- proof badges match verified bytes/state; and
- copy, semantic, responsive, keyboard, reduced-motion, and contrast gates pass.

## 13. Historical Migration Context

Historical migrations and dormant compatibility modules may retain `Rep` field names so
forward-only upgrades remain reproducible. That historical schema is not a current economy,
consumer surface, command, or fallback. Product-copy enforcement excludes migration files
but scans active guidance and selected bot, concierge, and web copy sources.
