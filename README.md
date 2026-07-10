# Called It

**Put the football call on the record.**

Called It is a Telegram football-call product for small groups. Add Callie to a group,
say a specific match claim, and take either side of a live offer in test SOL. TxLINE data
prices and settles the call; a public receipt shows deterministic terms, aggregate pots,
the result, and the available proof without exposing the original chat message.

This repository targets a SOL-only devnet beta. Test SOL has no monetary value. There is
no mainnet, fiat, product fee, points balance, or promise of profit in the beta contract.

## Direct Product Contract

Installation is setup and the first live offer is onboarding. No demo or replay onboarding
sits in front of the product.

1. An admin chooses **Add to Telegram group**. The versioned link requests only Telegram's
   `manage_chat` admin right.
2. Callie records the group and posts one ready message. That committed transition emits
   `group_ready` once.
3. A member makes a football call. An author mention or the author's own `/bookit` is
   explicit consent. Passive detection or another member's `/bookit` waits up to two
   minutes for the speaker alone to confirm or decline; no offer or public quote exists
   before confirmation.
4. The deterministic engine compiles and prices the confirmed terms. Every default offer
   presents exactly:

   - `It happens · 0.01 SOL`
   - `It does not · 0.01 SOL`
   - `Choose amount`

5. An eligible first 0.01 test-SOL tap may atomically receive and spend the limited starter
   grant. A committed position emits `position_placed` once.
6. TxLINE match events settle matched positions. Unmatched SOL is refunded. The receipt
   reports the result and the strongest proof actually available.

The only activation events are `group_ready` and `position_placed`. Page views, button
clicks, quotes, and confirmations are funnel diagnostics, not activation.

## Starter Grant

The beta can fund one exact 0.01 test-SOL first position per eligible verified Telegram
identity. The grant is treasury-backed, atomically created and consumed with that position,
disabled by default, and bounded by a 5 SOL or 500-grant global cap. Exhaustion or a disabled
switch is a normal unavailable state, not an account error.

The starter grant has no monetary value and is not a separate reward or guaranteed
entitlement. Never describe it as practice, demo, or free money.

## Commands And Surfaces

Private chat:

- `/start` gives the real add-to-group action and private account action.
- `/me` shows only the requesting member's test-SOL balance, verified wallet state, and
  open, pending, and settled positions with receipt links.
- `/wallet` opens the verified devnet wallet flow.
- `/help` lists only commands that are implemented in private chat.

Group chat:

- `/bookit`, used by the author on their own message, explicitly submits the call.
- `/table` opens the current group's aggregate SOL board.
- `/help` lists only implemented group commands.
- `/me` in a group never prints account data; it returns a private deep link.

`/table` and `/me` are intentionally different. The board is shared aggregate group state;
the account is private member state.

## Privacy And Proof

The engine is the single writer. The browser reads only curated public views, and the Eve
concierge uses only route-scoped private engine reads, quotes, and Telegram ingress
forwarding. Position commits stay on the engine-owned Telegram card or private account path.

- A public receipt identifies the confirmed speaker by a random, stable per-group alias
  such as `Player A1B2C3D4`.
- Public terms are rendered from the deterministic compiled market specification.
- Raw chat `quoted_text`, Telegram identity, display names, usernames, wallet addresses,
  individual positions, private balances, and ledger rows stay private.
- Group boards and receipts show only aggregate happens/does-not pots, matched SOL,
  refunds, payouts, participant count, timing, outcome, and proof state.
- `Chain-proven` is shown only after proof bytes verify against the Solana-published root.
  Otherwise the receipt says pending, unavailable, failed, or `Oracle-resolved` honestly.

## Recovery Language

Every refusal or interrupted flow must answer, in order:

1. What happened.
2. Whether SOL or saved state changed.
3. One next action.

For example: "The offer closed before confirmation. No SOL moved. Open `/table` for a live
call." Never imply success after a timeout or hide an uncertain write behind a generic
retry message.

## Monorepo

```text
apps/
  engine/          grammY bot, durable ingest, SOL positions, settlement, proofs, API
  web/             Next.js add entry, account bridge, group boards, public receipts
  concierge/       Eve conversation and Telegram webhook surface; engine API only
packages/
  market-engine/   pure deterministic claim compiler, pricing, settlement reducer
  txline/          typed TxLINE client, SSE sources, payload normalization
  agent/           deterministic prefilter plus GLM classify/parse/persona
  db/              Supabase schema, row types, service-role facades
  solana/          Txoracle/devnet clients, wallet helpers, proof verification
scripts/
  bootstrap-txline.ts     devnet TxLINE activation helper
  check-product-copy.ts   active product-copy contract gate
```

The engine owns all writes. The web never writes directly to Supabase. The concierge does
not import workspace domain packages, has no arbitrary money-mutation route, and does not
compute prices, balances, settlement, or proof outcomes.

## Development

Prerequisites: Node 22 or newer and the repository-declared pnpm 10.33.0.

```bash
npx -y pnpm@10.33.0 install
npx -y pnpm@10.33.0 typecheck
npx -y pnpm@10.33.0 test
npx -y pnpm@10.33.0 exec turbo run build --force
npx -y pnpm@10.33.0 --filter callie eve:build
npx -y pnpm@10.33.0 verify:product-copy
```

Local web smoke:

```bash
npx -y pnpm@10.33.0 --dir apps/web exec next dev --hostname 127.0.0.1 --port 3020
```

Running the engine with real environment values can connect to Telegram and TxLINE. Prefer
tests or explicit development credentials for local work. Do not print `.env` values.

## Historical Compatibility

Historical migrations and dormant compatibility code still contain the name `Rep`; those
fields are migration input only and are never current consumer guidance or a supported
economy. Do not edit old migrations to erase that history. New active product copy and new
SOL data paths must not depend on it.

Operational replay machinery may remain as dormant internal compatibility while the direct
beta is remediated, but it is not an onboarding path, advertised command, fixture source,
or public product surface.

## Product Sources

- [Product requirements](docs/PRD-called-it-mvp.md)
- [Design contract](DESIGN.md)
- [Cross-package contracts](CONTRACTS.md)
- [Eve concierge plan](docs/eve-concierge-plan.md)
