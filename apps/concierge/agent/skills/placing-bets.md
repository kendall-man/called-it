---
description: The procedure for putting Rep on a line conversationally — quoting a claim, presenting the price, staking on an open market, and handling refusals.
---

# Putting someone on the record

## Staking an EXISTING open market ("put me down 30 on the France one")

1. `get_group_snapshot` → find the market they mean by its terms. If two could
   match, ask which — never guess between markets.
2. Confirm side: "on" / "I'm in" / "backing" → back. "no chance" / "against" /
   "doubting" → doubt. If the side is genuinely unclear, ask.
3. `place_stake` with their exact amount. Large stakes pause for their
   inline-keyboard confirm automatically — that's expected, let it happen.
4. Report the result with the locked multiplier: "you're in — 30 riding at
   ×2.1." If state is "pending", add that it goes live in a moment (in-play
   fairness window).

## Pricing a NEW claim ("what would 'Spain win it' pay?")

1. `quote_claim` with their words verbatim.
2. `kind: ok` → present the line: terms, what backing pays, the trust tier if
   they care. `kind: clarify` → relay the question and the options, short.
   `kind: counter_offer` → explain the choice: as-stated settles from the feed
   only; the upgrade is chain-provable. `kind: reject` → relay the reason in
   character.
3. A quote is a price check, not a market. To make it real they say the claim
   in the chat (no @mention) and tap "Make him prove it" on the nudge card — tell them
   that when they want to go from price to live market.

## When the engine says no

Relay refusals faithfully, in voice, never as your own opinion:

- `pick_a_lane` → they already took the other side of this one.
- `cap_reached` → they've hit the 100 Rep ceiling on this market.
- `insufficient_rep` → not enough Rep; tell them their balance
  (`get_my_wallet`) and offer a smaller size.
- `window_closed` → too late in the match for new positions.
- `busy` → another action of theirs is mid-flight; one beat, try again.
- `closed` / `unavailable` → that market isn't taking positions any more.

Never retry a refused stake with altered parameters on your own initiative.

## Sizing guardrails

If they ask "max it" → that's 100 minus what they already have on the market
(check the snapshot / wallet). Sizes like "everything", "half", "a hundred
percent" → compute from `get_my_wallet`, state the number back, and let the
confirm gate do its job. Fractional or negative sizes don't exist — whole Rep
only.
