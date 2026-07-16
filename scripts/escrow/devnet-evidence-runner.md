# Devnet E2E Evidence Runner

This runner binds a transaction-capable evidence run to the public release
manifest and the exact Solana devnet deployment. It refuses every other
cluster, the wrong program, non-canonical USDC, Token-2022, a paused baseline,
role mismatches, duplicate roles, and deployment drift before invoking a
scenario driver.

Dry-run is the default. It reads and verifies credentials and chain state but
does not import a driver, sign a transaction, or mutate the chain. It prints
the preflight report by default, or writes that report when `--out FILE` is
provided.

## Inputs

Set the RPC URL only in the environment. Credentialed URLs are never included
in output.

```bash
export ESCROW_E2E_RPC_URL='https://devnet-rpc.example'
export ESCROW_E2E_CONFIG_AUTHORITY_KEYPAIR_PATH='/secure/config.json'
export ESCROW_E2E_MARKET_CREATION_AUTHORITY_KEYPAIR_PATH='/secure/market.json'
export ESCROW_E2E_FEED_OPERATOR_AUTHORITY_KEYPAIR_PATH='/secure/feed.json'
export ESCROW_E2E_PAUSE_AUTHORITY_KEYPAIR_PATH='/secure/pause.json'
export ESCROW_E2E_RELAYER_FEE_PAYER_KEYPAIR_PATH='/secure/relayer.json'
export ESCROW_E2E_ORACLE_SIGNER_1_KEYPAIR_PATH='/secure/oracle-1.json'
export ESCROW_E2E_ORACLE_SIGNER_2_KEYPAIR_PATH='/secure/oracle-2.json'
export ESCROW_E2E_SOL_USER_KEYPAIR_PATH='/secure/sol-user.json'
export ESCROW_E2E_USDC_USER_KEYPAIR_PATH='/secure/usdc-user.json'
export ESCROW_E2E_DIRECT_CLAIM_USER_KEYPAIR_PATH='/secure/direct-claim-user.json'
```

Each credential must be a distinct 64-byte Solana JSON keypair in a regular
file with mode `0600` or stricter. Operational and oracle public keys must
match the manifest. Keypair paths and private bytes are not placed in reports
or errors, and loaded credential properties are non-enumerable.

The manifest is the public `release-manifest.schema.json` shape consumed by
the existing release controls. It must identify the repository-pinned devnet
program and canonical devnet USDC mint.

## Preflight

```bash
npx -y pnpm@10.33.0 exec tsx \
  scripts/escrow/devnet-evidence-runner-cli.ts \
  --manifest /safe/public/devnet-release-manifest.json
```

The output has kind `devnet-e2e-preflight`, lists every planned scenario, and
states that zero transactions were submitted. `--out FILE` may be used to
write the preflight result to a new file.

## Live driver

Live execution is intentionally separated from orchestration. Set
`ESCROW_E2E_DRIVER_MODULE` to a reviewed local TypeScript or JavaScript module
that exports:

```ts
export async function createDevnetScenarioDriver() {
  return {
    async execute(id, context) {
      // Execute exactly the named scenario with context.credentials.
      // Return its unique finalized escrow-program transaction signature.
      return { transactionSignature: '...' };
    },
    async restoreBaseline(context) {
      // Always unpause and restore the manifest baseline, including on failure.
    },
  };
}
```

The driver receives the parsed public manifest, RPC URL/reader, non-enumerable
role credentials, and run ID. It must implement the scenario behavior; the
runner does not accept pre-recorded signatures as command-line input.

After each scenario, the runner requires a unique finalized successful
transaction that invokes the manifest program and falls within the current run
window. It rechecks exact devnet before every transaction-capable step. After
all scenarios, or after any failure, it calls `restoreBaseline`. A successful
run then re-verifies the complete public-manifest deployment before emitting
the existing `devnet-e2e-report` structure.

```bash
export ESCROW_E2E_DRIVER_MODULE='/reviewed/devnet-driver.ts'
npx -y pnpm@10.33.0 exec tsx \
  scripts/escrow/devnet-evidence-runner-cli.ts \
  --manifest /safe/public/devnet-release-manifest.json \
  --out /safe/evidence/devnet-e2e-report.json \
  --execute
```

Live output uses exclusive file creation and refuses to overwrite evidence.
The resulting report is ready for `scripts/escrow/cli.ts devnet-evidence`.
