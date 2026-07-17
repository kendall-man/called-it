# Called It Cross-Package Contracts

These contracts govern the direct SOL beta across packages and apps. Product behavior,
privacy, and copy must agree here, in `README.md`, `docs/PRD-called-it-mvp.md`,
`docs/eve-concierge-plan.md`, and `DESIGN.md`.

## Global Invariants

- TypeScript is strict and ESM. Domain types come from `@calledit/market-engine` instead of
  duplicated local unions.
- `packages/market-engine` is pure: no I/O, environment reads, clocks, random values,
  database code, Telegram code, or model calls.
- The engine is the single writer. The concierge reads scoped private engine routes and
  forwards Telegram ingress, but has no arbitrary money-mutation route. Browser code never
  receives engine/service-role credentials or writes Supabase.
- Every externally replayable mutation is idempotent and reports only after the durable
  effect commits.
- SOL/test SOL on Solana devnet is the only current economy. It has no monetary value; the
  product supports no mainnet, fiat, fee, or profit claim.
- Public data is aggregate and pseudonymous. Raw chat, Telegram identity, wallet identity,
  private balances, individual positions, and ledger rows remain private.
- Every user-facing failure says what happened, whether SOL or saved state changed, and one
  next action.

## Product Sequence

1. The landing action opens the versioned Telegram add URL and requests only `manage_chat`.
2. Membership/start updates create one group-ready marker and message, then emit
   `group_ready` exactly once.
3. Explicit speaker input proceeds. Passive or friend-triggered input waits for owner-only
   confirmation and publishes nothing before consent.
4. The compiler creates deterministic terms and the offer shows exactly:
   `It happens · 0.01 SOL`, `It does not · 0.01 SOL`, and `Choose amount`.
5. A default eligible first tap may atomically grant and spend 0.01 test SOL. A committed
   position emits `position_placed` exactly once.
6. Durable feed/settlement/proof work converges to aggregate group and receipt views.

`group_ready` and `position_placed` are the only activation events.

## Consent Contract

- Explicit: the author mentions Callie, uses `/bookit` on their own message, or uses an
  equivalent direct command bound to trusted identity.
- Passive/friend: create `awaiting_confirm` only, with owner-only Confirm/Decline and a
  two-minute expiry.
- Before owner confirmation: no market, public quote, receipt, or raw quote publication.
- Unauthorized, declined, expired, or duplicate confirmation creates no extra market.
- Clarification and counter-offer choices remain deterministic compiler inputs after
  consent.

## Account, Board, And Public Data

- `/me` is private requester state. In a group it returns only a private deep link.
- `/table` is the current group's aggregate SOL board, never a personal account or ranking
  economy.
- Public receipts identify the confirmed speaker only by a random stable per-group alias.
- Public terms come from `markets.spec` through deterministic formatting. Never publish
  `claims.quoted_text`.
- Public views may expose aggregate happens/does-not pots, matched/refunded/paid amounts,
  participant count, timing, outcome, and proof state. They expose no individual position.

## Starter Grant Contract

The starter grant is one 10,000,000-lamport credit for one eligible verified Telegram
identity's exact first 0.01 SOL position. It is disabled by default, treasury-backed, and
globally capped at 5,000,000,000 lamports or 500 grants. Grant, debit, and position occur in
one transaction. No grant can exist without its position.

The grant has no monetary value and is not guaranteed or separately claimable.
Never call starter funds practice, demo, or free money.

## `packages/market-engine`

Owns deterministic product truth:

- `compileClaim(parse, ctx)` validates the closed claim taxonomy, period, fixture/player,
  timing, and supported counter-offers.
- `priceSpec(spec, odds, ctx)` returns feed-derived probability, market parameters, and
  provenance without consumer copy.
- `reduceMarket(state, event)` owns freeze, pending-position fairness, reversal, void, and
  settlement effects.
- `checkDebounce(state, nowMs)` settles only after the deterministic evidence window.
- `evaluateSpec(spec, score, phase)` is the pure settlement predicate.

The package does not know Telegram identity, SOL balances, grants, database rows, public
aliases, receipts, or proof job execution. It returns typed facts for adapters to apply.

## `packages/txline`

Owns TxLINE transport, typed payload parsing, normalization, cursor-aware live sources, and
point-in-time source compatibility used by internal tests/operations. It produces normalized
events and odds inputs for the engine and never mutates product state.

- Parse external payloads at the boundary.
- Require full fixture/team/period matches; ambiguity fails closed.
- Preserve feed message/timestamp provenance needed for price and proof records.
- Do not commit provider payloads or expose them through public views.

## `packages/agent`

Owns deterministic prefiltering plus model-assisted classify/parse/persona. The model may
propose structured input and football copy; it cannot accept a market, choose identity,
invent a number, mutate money, or settle a result.

- Numbers in user copy come from deterministic/tool output.
- Prompt input is untrusted data.
- Persona fallback keeps action and status before football garnish.
- Deny-list rules reject odds notation, fiat framing, monetary-value claims, and stale
  primary-path vocabulary.

## `packages/db`

Owns schema, service-role facades, atomic RPCs, durable jobs, and curated public views. It
stays a typed data boundary; product evaluation remains in the pure core.

- Money mutations use append-only ledger entries and immutable idempotency keys.
- Starter eligibility, budget, credit, debit, and first position commit atomically.
- Wallet identity uses verified challenges and append-only link history.
- Telegram ingress, outbound ownership, settlement reconciliation, and proof work are
  durable, leased, retry-bounded, and private.
- Public views contain stable group aliases, deterministic specs, aggregate SOL, settlement,
  and proof fields only.
- Anon/authenticated roles cannot select private base tables or execute service RPCs.

## `packages/solana`

Owns devnet wallet/signature helpers, treasury transfer adapters, Txoracle submission, and
isomorphic proof verification.

- Verify the canonical wallet-link message against the trusted Telegram-bound challenge.
- Reject altered identity, pubkey, domain, cluster, nonce, and expiry.
- Proof status becomes verified only after bytes verify against the expected on-chain root.
- Never expose private keys, raw signatures, authorization material, or treasury state.

## `apps/engine`

The engine owns grammY behavior, trusted command/callback handling, group readiness, claim
consent, offers, positions, TxLINE ingest, settlement, proof jobs, chat delivery, and the
private HTTP API.

- Public engine health is only `GET /api/live` and `GET /api/ready`.
- Private route credentials are scoped: concierge read/quote routes, Telegram ingress, and
  operations status are separate tokens with wrong-scope requests rejected.
- Current Telegram ingress is a typed transitional port that acknowledges only after the
  bot handler resolves; durable ingress acceptance remains later work.
- Group-ready delivery is idempotent across membership and versioned-start updates.
- Position callbacks bind trusted user, group, market, side, amount, and source key.
- Default offer rows use the exact contract labels; larger choices are requester-scoped.
- Cards and API responses do not report success before the corresponding database commit.
- The engine posts shared card/status changes so button and concierge paths converge on one
  surface.
- Proof failure records an honest proof state and never reverses settlement.

## `apps/concierge`

The Eve app owns private conversation and scoped private API tool calls. Until the semantic
prefilter ships, every group message, including explicit Callie mentions, routes to the
engine. Eve imports no workspace package, writes no database, and never computes a product
fact.

- Identity comes from the verified Telegram/session principal, not model text.
- A quote is read-only and never substitutes for speaker consent.
- Position commits are not a model-facing direct tool; Callie points members to the
  engine-owned Telegram card or private account action.
- Callie relays committed/refused/pending state honestly and keeps the three-part recovery
  facts intact.
- Instructions contain the SOL direct flow, starter disclaimer, `/me`/`/table` boundary,
  privacy, and proof honesty. No demo or replay instruction is loaded.

## `apps/web`

The Next.js app owns the real add-to-group entry, same-origin account/event bridge, aggregate
group boards, and public receipts.

- The primary entry destination is the validated Telegram add URL, never a fragment or
  empty link.
- The browser makes no direct private-engine or Supabase write.
- Account responses are bound to verified Telegram session and requester identity.
- Group/receipt pages read curated views and treat realtime events only as invalidation.
- Receipt terms render from deterministic specs; raw chat is not a fallback.
- Loading, missing, private, proof-pending/unavailable, and error states remain complete and
  non-leaky.
- Components follow `DESIGN.md` for focus, motion, touch size, responsive reflow, and status.

## Active Copy Gate

`npx -y pnpm@10.33.0 verify:product-copy` runs behavior tests and scans active guidance,
concierge instructions, SOL bot copy, and user-facing web source. It rejects primary-path
alternate-economy language and misleading starter/value claims. No demo or replay onboarding
instruction or literal hash-only anchor destination may pass.

Historical migrations and dormant `Rep` compatibility fields are excluded from consumer
copy enforcement so forward-only schema history stays reproducible. Historical replay code
may remain internally during remediation, but it is not a current command or onboarding
contract.
