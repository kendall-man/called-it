# Called It House Rules

Called It uses SOL/test SOL on Solana devnet only. Test SOL has no monetary value. There is
no mainnet, fiat, product fee, points balance, or personal ranking economy.

## Calls And Consent

- An author mention with a football claim or the author's own `/bookit` is explicit consent
  to compile and offer that call.
- Passive detection or a friend's `/bookit` creates only an owner confirmation. The original
  speaker has two minutes to confirm or decline.
- No confirmation means no market. Raw chat text is private and is never the public receipt
  wording.
- Clarification and counter-offer choices come from the deterministic compiler. Never guess
  a fixture, player, period, or settlement condition.

## Offer Actions

Every offer shows two side actions labeled by deterministic per-claim templates from the
compiled spec (binary fallback: `It happens` / `It does not`). The default tap books
0.01 SOL; 0.05/0.10 SOL are requester-scoped choices. One member may take only one side of
a market and may place at most 0.10 SOL total on that market.

## Starter Grant

An eligible verified first-time member may receive one 0.01 test-SOL starter grant only in
the same atomic commit as their default first position. It is limited, disabled by default,
not guaranteed, and has no monetary value. It is not a separate balance to claim.

If starter support is unavailable, say that no SOL or position changed and give the private
account action as the next step. Never describe it as practice, demo, or free money.

## Matching And Settlement

- Positions are peer-matched at the deterministic feed-derived price. The product does not
  take the opposing side and charges no fee.
- Only matched SOL is exposed to the result. Unmatched SOL is refunded at settlement; if no
  counterparty appears, the position is returned in full.
- Winners receive matched principal plus their pro-rata share of the matched opposing pot.
- A pre-match position can commit immediately. An in-play position can remain pending for a
  short feed-fairness window and can be voided if the deciding event predates the tap.
- New positions close at the configured late-match cutoff or whenever the market/feed is not
  safely accepting them.
- Settlement comes from normalized TxLINE events and deterministic market terms. Duplicate
  events or callbacks cannot duplicate a position, refund, payout, or receipt.

## Account And Board

- `/me` is private to the trusted requester and shows their test-SOL account and positions.
- `/table` is shared group state and shows only aggregate calls, pots, matching, timing, and
  receipts.
- Wallet setup uses verified Telegram Mini App identity and a signed Solana devnet wallet
  challenge. Never ask for a private key or accept an address pasted into chat as proof.
- Funding a preserved larger-position intent does not place it. The member must confirm the
  same side and amount after funding.

## Proof

Team-stat receipts may become `Chain-proven` after proof bytes verify against the root on
Solana devnet. Other supported results are `Oracle-resolved`. Pending, unavailable, and
failed proof states are honest outcomes and never alter deterministic settlement.

For an edge case not covered here, report the tool state, preserve whether SOL changed, and
point to the receipt or private account instead of inventing a rule.
