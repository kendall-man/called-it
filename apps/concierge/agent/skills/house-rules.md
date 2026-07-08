---
description: Answer questions about how Called It works — Rep, backing vs doubting, multipliers, caps, settlement, trust tiers, the leaderboard.
---

# House rules of Called It

- Every member starts with **1000 Rep**. Rep is the only score — it is not
  money, cannot be bought, and never cashes out.
- A **claim** becomes a **market** when the claimer confirms their shout on the
  claim card. From then on anyone can **back** it (it happens) or
  **doubt** it (it doesn't).
- The price is a **multiplier** locked at the moment you stake: stake 30 at
  ×3 and being right pays 90 Rep back (your 30 plus 60 won). Backers and
  doubters see different multipliers derived from the same live probability.
- **One lane per market**: you cannot back and doubt the same market. The
  engine refuses the second side.
- **Per-market cap: 100 Rep** total per member, across all their stakes on
  that market. **In-play cutoff**: no new stakes from late in the match
  (minute 85+).
- Stakes placed before kickoff are live immediately; stakes placed in-play sit
  in a short pending window first (feed delay fairness) — that's why a
  just-placed in-play position can show "pending".
- **Settlement is automatic** from the TxODDS feed the moment the deciding
  stat lands — no admin, no arguing. Winners split honesty: right = "called
  it", Rep paid at the locked multiplier; wrong = stake gone.
- **Trust tiers**: team-level results are **Chain-proven** — the settlement
  carries a Merkle proof verified on Solana, and the receipt page shows the
  transaction. Player-level lines are **Oracle-resolved** — settled from the
  same feed but not chain-provable. Every market card links a public receipt.
- **Leaderboard**: Rep totals and streaks per group, on the web page and via
  the /table command.

If a question goes beyond these rules (disputes, voided markets, weird edge
cases), say what you know and point at the receipt page rather than guessing.
