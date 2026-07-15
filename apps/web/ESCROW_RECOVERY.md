# Escrow Claim Recovery

The normal wallet screen builds and submits `claim_position` directly through
Solana RPC. It does not call the Called It engine or a claim API. If the engine
is unavailable, the browser path remains usable.

If the Called It web host is also unavailable, an owner can recover through an
independent TypeScript wallet or CLI using `@calledit/escrow-sdk`:

1. Pin the expected cluster genesis hash, escrow program ID, and canonical USDC
   mint from the published deployment manifest.
2. Read the market PDA and owner position PDA at `finalized` commitment.
3. Decode both with `decodeMarketAccount` and `decodeUserPositionAccount`.
4. Verify the accounts are owned by the pinned program; the market UUID,
   recorded owner, position PDA, asset, mint, and market vault all match; the
   market is settled or voided; and the position is eligible and not claimed.
5. Build exactly one instruction with `materializeInstruction`:

   ```ts
   materializeInstruction({
     kind: 'claim_position',
     marketUuid,
     owner: ownerPublicKey,
     asset: market.asset,
     canonicalUsdcMint,
   }, { programId });
   ```

6. Build an owner-fee-paid v0 transaction with
   `buildUnsignedV0Transaction`, verify its full message, then sign it with the
   owner's external wallet or local Solana keypair and submit it to the pinned
   RPC.
7. Treat the result as complete only after the signature and owner position are
   both finalized and the position decodes with `claimed: true`.

There is intentionally no destination argument. For SOL, the program sends to
the recorded owner. For USDC, it derives the recorded owner's canonical classic
SPL associated token account. `claim_position_for` remains available to an
independent sponsor, but it cannot redirect funds.

Never accept a transaction supplied through chat or support without repeating
the full message and destination checks above.
