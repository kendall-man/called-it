# Escrow local-validator integration

This package drives the deployed Anchor program with real transactions on a reset
`solana-test-validator`. It uses deterministic test-only role keys and never prints
or copies keypair material.

Prerequisites:

- Program: `HrKUo8Bue31kU9sobzQGK5qDxVxBu5nBLXP3aGeKCDFL`
- Upgrade authority: `~/.config/solana/id.json`
- External program identity: `/private/tmp/calledit-beta-secrets/calledit_escrow-devnet-keypair.json`
- External program artifact: `/private/tmp/calledit-beta-artifacts/calledit_escrow.so`
- Offline classic SPL Token 3.5.0 and Associated Token Account 1.1.1 SBF
  artifacts from the installed LiteSVM crate cache

`test:local` starts its own validator on RPC `18999` and faucet `19900`, creates a
unique temporary ledger, preloads the program, and removes the process and ledger
in a `finally` block. It does not use a shared validator session. Override the
offline SPL paths with `SPL_TOKEN_PROGRAM_ARTIFACT` and
`SPL_ASSOCIATED_TOKEN_PROGRAM_ARTIFACT` when the default crate cache is absent.

Transactions use exact-byte retries for transient submission loss. A phase is
successful only after the signature and all asserted account state are observed
at `finalized`; a merely `confirmed` transaction never emits success.

Run from the repository root:

```bash
npx -y pnpm@10.33.0 --filter @calledit/escrow-sdk build
npx -y pnpm@10.33.0 --filter @calledit/escrow-integration typecheck
npx -y pnpm@10.33.0 --filter @calledit/escrow-integration test
npx -y pnpm@10.33.0 --filter @calledit/escrow-integration test:local
```

`test:local` is intentionally destructive only to its disposable local ledger. It
does not connect to devnet or mainnet and uses no real funds.
