# Devnet Escrow Bootstrap

This tool deploys or upgrades only the repository-pinned Called It escrow
program on Solana devnet, then initializes or verifies its exact
`ProtocolConfig` and epoch-1 2-of-3 `OracleSet`.

It is read-only by default. `--execute` is required before it can deploy,
submit a transaction, or write an output file. It never changes
`WAGER_CUSTODY_MODE`, production environment files, mainnet authorities, or
mainnet accounts.

## Frozen devnet profile

- Cluster genesis: `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`
- Program: `HrKUo8Bue31kU9sobzQGK5qDxVxBu5nBLXP3aGeKCDFL`
- Canonical USDC: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`
- Token program: classic SPL Token (`Tokenkeg...`), never Token-2022
- SOL positions: 0.001 SOL minimum, 0.05 SOL maximum
- USDC positions: 1 USDC minimum, 25 USDC maximum
- Maximum market duration: 24 hours
- Maximum resolution delay: 6 hours
- Oracle set: epoch 1, exactly three distinct signers, threshold 2, no retirement

The activation slot is explicit because it is immutable on the OracleSet. Pick
a future devnet slot that leaves enough time to run the deployment and reuse
the same value on every retry. The script refuses an activation slot that is
already behind the finalized slot.

## Required keypairs

Provide separate `0600` Solana JSON keypair files for the program identity,
upgrade authority, transaction payer, config authority, pause authority,
market-creation authority, feed operator, relayer fee payer, residual recipient,
and three oracle signers. The tool refuses duplicate role public keys. It never
creates, prints, copies, or embeds a secret key.

The upgrade authority pays the ProtocolConfig account rent because the program
requires the initializer to fund that account. The transaction payer pays
transaction fees and the OracleSet account rent. Fund both with devnet test SOL
before using `--execute`.

## Dry run

Keep a credentialed RPC URL in an environment variable so it is not placed in
the command itself:

```bash
export SOLANA_DEVNET_RPC_URL='https://your-devnet-rpc.example'

npx -y pnpm@10.33.0 escrow:devnet -- \
  --program-keypair /secure/devnet/program.json \
  --program-so /absolute/path/calledit_escrow.so \
  --upgrade-authority-keypair /secure/devnet/upgrade.json \
  --transaction-payer-keypair /secure/devnet/payer.json \
  --config-authority-keypair /secure/devnet/config.json \
  --pause-authority-keypair /secure/devnet/pause.json \
  --market-creation-authority-keypair /secure/devnet/market.json \
  --feed-operator-authority-keypair /secure/devnet/feed.json \
  --relayer-fee-payer-keypair /secure/devnet/relayer.json \
  --residual-recipient-keypair /secure/devnet/residual.json \
  --oracle-1-keypair /secure/devnet/oracle-1.json \
  --oracle-2-keypair /secure/devnet/oracle-2.json \
  --oracle-3-keypair /secure/devnet/oracle-3.json \
  --oracle-activation-slot 123456789 \
  --manifest-out /safe/public/escrow-devnet-manifest.json \
  --env-out /safe/public/escrow-devnet.env
```

The dry run verifies the RPC genesis, canonical mint, keypair-derived program
identity, deployed program/upgrade authority when present, and all existing
config/oracle fields. It reports the actions that `--execute` would take and
does not write the two output files.

After reviewing the dry-run output, repeat the identical command with
`--execute`. The script rechecks the devnet genesis immediately before and
after every mutable phase, waits for finalized transaction confirmation, and
then rereads all accounts before writing outputs.

The JSON manifest and env fragment contain public keys, hashes, caps, and
horizons only. They omit the RPC URL, every keypair path, private bytes,
`ESCROW_RELAYER_KEYPAIR_B58`, and `WAGER_CUSTODY_MODE`. Enabling escrow remains
a separate reviewed release action.
