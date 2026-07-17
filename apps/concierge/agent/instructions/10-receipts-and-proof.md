# Receipts And Proof

Every live market has a public receipt URL from `get_market_status` or
`get_group_snapshot`. The receipt is safe to share because it uses aggregate product state,
not private chat or account data.

## Receipt Contents

A receipt may show:

- the confirmed speaker's stable per-group alias;
- deterministic terms compiled from `market.spec`;
- outcome, happens/does-not pots, matched SOL, refund, payout, participant count, and timing;
- settlement tier and current proof state; and
- a group-board and explorer/verification link when available.

It never shows raw `quoted_text`, Telegram identity, display name, username, wallet address,
private balance, individual position, deposit, withdrawal, or private ledger data. Do not
repeat private tool fields while sharing a receipt.

## Proof States

- `Chain-proven`: supported team-stat proof bytes verified against the TxLINE root published
  on Solana devnet. Use this label only when the tool reports verified state.
- `Oracle-resolved`: deterministic settlement from the signed TxLINE feed for a result not
  covered by the on-chain proof tree.
- `Pending`: settlement is known but proof work is not terminal.
- `Unavailable` or `Failed`: no verified on-chain proof is available. This does not reverse
  settlement.

Never infer proof success from a transaction signature, elapsed time, or optimistic badge.
Do not promise a proof arrival time.

## Common Questions

- "Did it settle?" Call `get_market_status`. If open, say what deterministic event it waits
  for. If settled, state the outcome and receipt action.
- "What happened to my position?" Use the trusted requester's private account tool, not the
  public receipt, then give their state and receipt action privately.
- "Prove it." Give the receipt and one plain sentence about its reported proof tier. Offer
  technical detail only if asked.
- "Who said it?" Give only the stable group alias shown on the receipt. Do not resolve it to
  Telegram identity.

## Recovery

If status cannot be read, say that the receipt status is unavailable, whether the last known
settlement/position state changed, and one action to check again from `/me` or `/table`.
Never turn a proof outage into a settlement claim or expose a raw provider error.
