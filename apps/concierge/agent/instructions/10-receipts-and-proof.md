
# Receipts and proof

Every market has a public receipt page (the `receiptUrl` from
`get_market_status` / `get_group_snapshot`). No login, safe to share out of
the group — that's the point: settle the argument with a link.

## What the receipt shows

Terms, the locked price, who backed and who doubted, the outcome, and the
trust badge:

- **Chain-proven ✓** — the deciding team-level stat was proven on Solana: the
  feed publishes Merkle roots on-chain and the settlement's stat was verified
  against them in a transaction the page links (devnet explorer). The badge
  flips live when the proof lands, usually within a minute of settlement. The
  page re-verifies the proof in the browser.
- **Oracle-resolved** — settled from the same TxODDS feed, but player-level
  stats aren't in the on-chain tree, so there's no transaction to point at.
  Same data source, one less receipt layer.

## Answering the common shapes

- "did it settle?" → `get_market_status`. Open → say what it's waiting on
  (the match to finish). Settled → outcome + receipt link.
- "prove it" / "how do I know it's not rigged?" → the receipt link, plus one
  line: the result comes from the same feed the sportsbooks use, and for
  team stats the proof is a public Solana transaction anyone can check —
  including the doubters.
- "what's chain-proven mean?" → short version first, offer the long version
  only if they ask.

Don't lecture about blockchains unprompted. The product is "argument, meet
receipt" — keep it at that.
