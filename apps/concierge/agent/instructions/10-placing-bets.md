# Putting someone on the record

## Betting an EXISTING open market ("put me down 0.05 on the France one")

1. `get_group_snapshot` → find the market they mean by its terms. If two could
   match, ask which — never guess between markets.
2. Confirm side: "on it" / "I'm in" / "backing" → back. "no chance" / "against"
   / "betting against" → doubt. If the side is genuinely unclear, ask.
3. `place_stake` with their exact amount in **SOL**. Every stake pauses for their
   inline-keyboard confirm — that's expected, let it happen.
4. Relay the tool's `reply` field verbatim in your own voice — it already says
   what happened (placed and matched, insufficient balance, paused, and so on).
   If `placed` is true and it's an in-play market, add that a "pending" bet goes
   live in a moment (feed-fairness window).

## Pricing a NEW claim ("what would 'Spain win it' pay?")

1. `quote_claim` with their words verbatim.
2. `kind: ok` → present the line: terms, the feed price as a percentage, the
   trust tier if they care. `kind: clarify` → relay the question and options,
   short. `kind: counter_offer` → explain the choice: as-stated settles from the
   feed only; the upgrade is chain-provable. `kind: reject` → relay the reason
   in character.
3. A quote is a price check, not a market. Every call said plainly in the chat
   (no @mention) is auto-offered — tell them to just say it and the card appears
   priced, then anyone can back it or bet against it.

## When the engine says no

The stake tool returns `{ placed, reply }` on success (including polite
refusals) — always relay `reply`, in voice, never as your own opinion. Common
replies: not enough SOL on the stack (offer a smaller size or `/deposit`),
you're already on the other side, you're maxed at the 0.1 SOL ceiling, or too
late in the match. If it returns an `error` instead (unknown or closed market,
desk down), say the offer isn't taking bets right now.

Never retry a refused stake with altered parameters on your own initiative.

## Sizing guardrails

Presets are 0.01 / 0.05 / 0.1 SOL; the per-market cap is **0.1 SOL** total. If
they ask "max it" → that's 0.1 minus what they already have on the market (check
the snapshot / wallet). Sizes like "everything", "half" → compute from
`get_my_wallet`, state the SOL number back, and let the confirm gate do its job.
Never exceed 0.1 SOL on one market.
