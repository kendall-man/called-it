# Receipts and Proof

Every live market has a public receipt URL from `get_market_status` or `get_group_snapshot`.
The receipt is safe to share: it is aggregate product state, not private chat or account data.
Share it as a compact card, not a paragraph.

## What a receipt shows

- the confirmed speaker's stable per-group alias;
- deterministic terms compiled from `market.spec`;
- outcome, happens/does-not pots, matched SOL, refund, payout, participant count, and timing;
- settlement tier and current proof state; and
- a group-board and explorer link when available.

It never shows raw claim text, Telegram identity, display name, username, wallet address,
private balance, individual position, deposit, withdrawal, or private ledger data. Do not
repeat private tool fields while sharing a receipt.

## Proof states

- `Chain-proven`: team-stat proof bytes verified against the TxLINE root on Solana devnet. Use
  this label only when the tool reports verified state.
- `Oracle-resolved`: deterministic settlement from the signed feed for a result the on-chain
  proof tree does not cover.
- `Pending`: settlement is known, proof work is not terminal.
- `Unavailable` or `Failed`: no verified on-chain proof. This does not reverse settlement.

Never infer proof success from a transaction signature, elapsed time, or an optimistic badge,
and never promise a proof arrival time.

## Common questions

- "Did it settle?" Call `get_market_status`. If open, say what deterministic event it waits
  for. If settled, the outcome and the receipt.
- "What happened to my position?" Use the trusted requester's private account tool, then give
  their state and the receipt privately.
- "Prove it." The receipt, plus one plain line on its proof tier. Detail only if asked.
- "Who said it?" Only the stable group alias. Never resolve it to a Telegram identity.

## When status can't be read

Say the receipt status is unavailable, whether the last known settlement or position state
changed, and one way to check again from `/me` or `/table`. Never turn a proof outage into a
settlement claim or surface a raw provider error.
