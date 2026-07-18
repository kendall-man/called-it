# Escrow Claim Recovery

The normal wallet screen builds and submits `claim_position` directly through
Solana RPC. It does not call the Rumble engine or a claim API. If the engine
is unavailable, the browser path remains usable.

If the Rumble web host is also unavailable, use the standalone
`@calledit/escrow-recovery` client. It imports no engine, web, database, or
relayer code. Build it once from the pinned source release:

```bash
pnpm --filter @calledit/escrow-recovery build
```

Pin these public values from the published deployment manifest rather than from
a chat message or support reply:

```bash
RPC_URL=https://api.devnet.solana.com
GENESIS_HASH=EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG
PROGRAM_ID=<published-escrow-program-id>
USDC_MINT=<published-canonical-usdc-mint>
MARKET_UUID=<market-uuid>
OWNER=<owner-wallet-public-key>
```

Inspect finalized eligibility without building or submitting a transaction:

```bash
pnpm --silent escrow:recovery -- inspect \
  --rpc "$RPC_URL" --genesis "$GENESIS_HASH" \
  --program "$PROGRAM_ID" --usdc-mint "$USDC_MINT" \
  --market "$MARKET_UUID" --owner "$OWNER"
```

Use `claim` for a settled payout, `refund` for an already-voided market, or
`timeout-refund` after the immutable resolution deadline. These commands are
dry-run by default and emit one JSON evidence document containing the finalized
slot, deployment and account bindings, SOL wallet or canonical USDC ATA
destination, expected amount, exact instruction list, message hash, and unsigned
transaction:

```bash
pnpm --silent escrow:recovery -- claim \
  --rpc "$RPC_URL" --genesis "$GENESIS_HASH" \
  --program "$PROGRAM_ID" --usdc-mint "$USDC_MINT" \
  --market "$MARKET_UUID" --owner "$OWNER"
```

`timeout-refund` atomically submits `timeout_void` followed by
`claim_position`; it does not depend on an operator performing the void first.

Direct submission is deliberately restricted to canonical Solana devnet. The
owner keypair must be a regular, non-symlink Solana JSON keypair file owned by
the current user with mode exactly `0600`. The client accepts only its path and
never accepts or prints raw secret bytes:

```bash
chmod 600 "$OWNER_KEYPAIR_PATH"
pnpm --silent escrow:recovery -- refund \
  --rpc "$RPC_URL" --genesis "$GENESIS_HASH" \
  --program "$PROGRAM_ID" --usdc-mint "$USDC_MINT" \
  --market "$MARKET_UUID" --owner "$OWNER" \
  --submit --keypair "$OWNER_KEYPAIR_PATH" \
  --devnet-write-consent I_UNDERSTAND_THIS_WRITES_TO_SOLANA_DEVNET
```

The client rechecks genesis and blockhash validity immediately before signing,
submits directly to Solana RPC, and reports success only after both transaction
finality and `position.claimed = true`. An `unknown` result is not permission to
resign or retry; rerun `inspect` against finalized state first.

The client performs these checks before emitting any transaction:

1. Match RPC and on-chain config genesis hashes to the pinned genesis.
2. Require the pinned program account to be executable and every escrow account
   to be owned by it.
3. Decode config, market, and owner position at `finalized` commitment.
4. Verify the market UUID,
   recorded owner, position PDA, asset, mint, and market vault all match; the
   operation is eligible; and the position is not claimed.
5. Verify classic SPL Token ownership, six mint decimals, market-owned USDC
   vault, and any existing owner ATA.
6. Build an exact owner-fee-paid v0 transaction with no lookup tables or extra
   signers. `claim` and `refund` contain only:

   ```ts
   materializeInstruction({
     kind: 'claim_position',
     marketUuid,
     owner: ownerPublicKey,
     asset: market.asset,
     canonicalUsdcMint,
   }, { programId });
   ```

There is intentionally no destination argument. For SOL, the program sends to
the recorded owner. For USDC, it derives the recorded owner's canonical classic
SPL associated token account. `claim_position_for` remains available to an
independent sponsor, but it cannot redirect funds.

Never accept a transaction supplied through chat or support without repeating
the full message and destination checks above.
