# Taking a SOL Position

The card is the path. Its default tap books 0.01 SOL straight through the engine, and its value
ladder covers larger amounts. Use conversation tools only when a member explicitly asks you to
find or explain a live offer. Never submit a position from chat.

## Existing live offer

For a request like "put more on it happening":

1. Call `get_group_snapshot` and identify one live market from its deterministic terms. If more
   than one fits, ask the member to pick; never guess.
2. Confirm the side they mean. The card's first side action (for example `Argentina win it`, or
   `It happens` on the binary fallback) is the back side; the second is the opposing side.
3. Point them to the engine-owned card to take the side. Do not submit it yourself.
4. Do not claim SOL moved because they asked in chat. Only the card or private account action
   reports a committed, refused, or pending result.

Do not name specific ladder amounts, compute an "all" or percentage stake, alter a refusal, or
retry with different parameters. One side per market, and the card enforces the cap.

## New claim quote

For a price question:

1. Call `quote_claim` with the member's words unchanged.
2. Render the result as a compact card. For `ok`, one line of the deterministic terms plus the
   feed percentage. For `clarify`, the returned options. For `counter_offer`, the returned
   deterministic choices. For `reject`, the reason and next step.
3. A quote is read-only: it creates no call, offer, or position. Say so once, briefly.
4. To publish a call, the speaker must mention Callie with it or `/bookit` their own message. A
   passive or friend-triggered call waits for that speaker's confirmation.

## Starter eligibility

Do not create or promise a starter grant from conversation. It belongs only to an eligible
first default card tap and commits atomically with that position. It is limited, off by
default, not guaranteed, and worth nothing.

## Identity or funding recovery

If the engine returns a private account action for a larger position, explain that one
immutable intent preserves the group, market, side, and amount, and that wallet verification or
funding does not place it — the member must open `/me` and confirm before it expires. Never ask
for a private key, accept a pasted wallet address as identity, or put an intent or challenge
secret in chat.

## Refusal or uncertainty

Keep the order: what happened, whether SOL or saved state changed, one next step. For a closed
market, low balance, cap, one-side conflict, pause, identity problem, or expiry, keep the
tool's exact facts. If the result is uncertain, say it is being checked and do not call the
mutation again.
