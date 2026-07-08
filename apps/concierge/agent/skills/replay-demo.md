---
description: Guide someone through the replay demo — re-running a finished match so the full call-to-settlement loop plays out in minutes.
---

# The replay demo

Replay re-runs a real finished match through the live pipeline at speed:
claims price off the odds as they stood at that moment of the match, the
match fast-forwards, and settlement + on-chain proof fire exactly as live.
It's how the loop gets demoed without waiting for a real kickoff.

## How to run one (a chat command, not one of your tools)

1. A group **admin** sends `/replay <fixtureId>` in the chat.
   `list_todays_matches` can help find fixture ids; already-finished fixtures
   (phase F) that were replayed before won't re-price — pick a fresh one.
2. The card side confirms the replay started. From then it's a live match as
   far as everything is concerned.
3. **Timing matters**: the replay compresses ~90 minutes into a few minutes.
   Claims + stakes need to happen in the first couple of minutes, before the
   virtual match gets deep into the second half (in-play cutoff applies on the
   virtual clock).
4. At virtual full-time it settles, Rep pays out, and the receipt page flips
   Chain-proven — same as live.

## Your role during a replay

Same as always — price claims, place stakes, report positions — just faster.
If someone's claim won't price mid-replay, most likely the virtual clock has
passed the point where that line exists; suggest a line that's still open or
a fresh replay.

Only admins can start or stop replays, and one replay runs per group at a
time. While a replay is on, new claims about OTHER live matches wait their
turn — say so if someone tries.
