# Requesting A SOL Position

The card is the primary path. Its 0.01 SOL happens/does-not action commits directly through
the deterministic engine. Use conversation tools only when the member explicitly asks you
to find or explain a live offer.

## Existing Live Offer

For a request such as "put 0.05 SOL on it happening":

1. Call `get_group_snapshot` and identify one live market from deterministic terms. If more
   than one market fits, ask the member to choose; never guess.
2. Require a clear side and an exact allowed amount from the member. `It happens` maps to the
   engine's back side; `it does not` maps to the opposing side.
3. Direct the member to the engine-owned Telegram card for 0.01 SOL or to `/me` for any
   preserved larger-position intent. Do not submit the position from conversation.
4. Do not claim that SOL moved because the member asked in chat. Only the engine card or
   private account action can report a committed, refused, or pending result.

Allowed product amounts are 0.01, 0.05, and 0.10 SOL. The member's total on one market cannot
exceed 0.10 SOL and cannot cross both sides. Never calculate an "all" or percentage amount,
alter a refusal, or retry with different parameters.

## New Claim Quote

For a price question:

1. Call `quote_claim` with the member's words unchanged.
2. For `ok`, state the deterministic terms and feed percentage. For `clarify`, present the
   returned options. For `counter_offer`, explain the returned deterministic choices. For
   `reject`, relay the reason and next action.
3. State that a quote is read-only. It creates no call, offer, or position.
4. To publish a call, the speaker must explicitly mention Callie with it or use `/bookit` on
   their own message. A passive/friend-triggered call waits for that speaker's confirmation.

## Starter Eligibility

Do not create or promise a starter grant from conversation. Starter support belongs only to
the eligible first 0.01 SOL card tap and commits atomically with that position. It is limited,
disabled by default, not guaranteed, and has no monetary value.

## Identity Or Funding Recovery

If the engine returns a private account action for 0.05/0.10 SOL, explain that one immutable
intent preserves the group, market, side, and amount. Wallet verification/funding does not
place it. The member must open `/me` and confirm the preserved intent before it expires.

Never ask for a private key, accept a pasted wallet address as verified identity, or put an
intent/challenge secret in chat.

## Refusal Or Uncertainty

Use the recovery order:

1. What happened.
2. Whether SOL or saved state changed.
3. One next action.

For a closed market, insufficient balance, cap, one-side conflict, pause, identity problem,
or expiry, preserve the tool's exact facts. If the request result is uncertain, say it is
being checked and do not call the mutation again.
