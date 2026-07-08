# House rules of Called It

Called It runs on **devnet SOL** — test-network tokens, not real money. There's
no play-money score, no leaderboard: you bet devnet SOL and you cash it out.

## Getting set up

- `/wallet <address>` links your devnet Solana wallet (first to link an address
  keeps it).
- `/deposit` shows the table treasury address — send devnet SOL there to load
  your stack. It credits automatically within a minute.
- `/withdraw <amount|all>` sends devnet SOL back to your linked wallet any time.
  Your balance and cashouts are never frozen.

## How a bet works

- When someone makes a **call**, the bot prices it from the live feed and posts
  an **offer** straight away — no confirm step. The claimer can back their own
  call, and anyone can **back** it (it happens) or **bet against** it (it
  doesn't).
- The offer is **peer-matched**: your SOL is matched against the SOL on the
  other side at the feed price locked when the market was made. If the feed says
  61%, roughly 0.61 of backing SOL is covered by 0.39 of against SOL — the card
  shows the For pot, the Against pot, and what % is **matched**.
- **Unmatched SOL is never at risk.** If one side is bigger, the excess just
  comes back at settlement. If nobody takes the other side, every stake is
  returned in full — no counterparty, no bet.
- The bot is a **broker, not a bookie**: the treasury only escrows the stakes.
  Winners are paid from the opposing pot, so the house never fronts money.

## Limits and timing

- **One side per market**: you can't back and bet against the same call.
- **Per-market cap: 0.1 SOL** total per member on a single market. Presets are
  0.01 / 0.05 / 0.1 SOL.
- **In-play cutoff**: no new stakes from late in the match (minute 85+).
- Stakes before kickoff are live immediately; in-play stakes sit in a short
  pending window first (feed-delay fairness) — that's why a just-placed in-play
  bet can show "pending".
- A call that nobody bets on gets voided at kickoff — no one showed, so no SOL
  moved.

## Settlement

- **Automatic** from the TxODDS feed the moment the deciding stat lands — no
  admin, no arguing. Winners get their own stake back plus their share of the
  matched losing pot, pro-rata; losers forfeit only their matched stake.
- **Trust tiers**: team-level results are **Chain-proven** — the settlement
  carries a Merkle proof verified on Solana, and the receipt page shows the
  transaction. Player-level lines are **Oracle-resolved** — settled from the
  same feed but not chain-provable. Every offer card links a public receipt.

If a question goes beyond these rules (disputes, voided markets, weird edge
cases), say what you know and point at the receipt page rather than guessing.
