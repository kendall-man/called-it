# Escrow Operations And Release Controls

This runbook covers the per-market SOL and canonical-USDC escrow path. The
commands in `scripts/escrow/cli.ts` are read-only except `provenance --out`,
which creates a new local manifest and refuses to overwrite an existing file.
They never sign, deploy, upgrade, pause, submit a transaction, or mutate chain
state.

## Oracle Signer Deployments

Run each settlement signer as a separate Railway service with its own HTTPS
origin, bearer token, Ed25519 key, and durable journal volume. Configure all
three services to use `apps/oracle-signer/railway.json`; the repository-root
`railway.json` is the engine profile and must not be used for signer services.

Each signer service must have exactly one replica. A signer key must never be
loaded by another service or replica. The three services may share source code,
but must use independent TxLINE credentials, finalized Solana RPC endpoints,
and journal volumes. Before enabling intake, call each configured `/sign`
endpoint with `GET` and verify that it returns its expected, distinct public
key. A quorum is ready only when at least two expected services answer and the
engine `/api/ready` endpoint returns HTTP 200.

## Standalone Direct Recovery

`apps/escrow-recovery` is the engine-, web-, database-, and relayer-independent
owner recovery client. Its commands read finalized Solana state and default to
dry-run JSON evidence. Direct submission is restricted to canonical devnet and
requires an owner-matching `0600` keypair file plus the exact write-consent
token. It supports settled claims, void refunds, and atomic timeout-void plus
refund for both SOL and canonical USDC.

Use [the recovery runbook](../apps/web/ESCROW_RECOVERY.md) for the complete
command contract. Archive its JSON output for both SOL and USDC recovery probes;
an `unknown` submission must be resolved by a new finalized inspection before
any replacement transaction is signed.

## Control Commands

Use the repository-pinned package manager and never put credentials in a JSON
input or command line.

```bash
npx -y pnpm@10.33.0 exec tsc -p scripts/escrow/tsconfig.json --noEmit
npx -y pnpm@10.33.0 exec tsx --test scripts/escrow/release-controls.test.ts

npx -y pnpm@10.33.0 exec tsx scripts/escrow/cli.ts provenance \
  --program-so target/deploy/calledit_escrow.so \
  --idl target/idl/calledit_escrow.json \
  --source programs/calledit-escrow \
  --lock Cargo.lock \
  --source-commit "$(git rev-parse HEAD)" \
  --out build-manifest.json

npx -y pnpm@10.33.0 exec tsx scripts/escrow/cli.ts compare-builds \
  --left build-a.json --right build-b.json

npx -y pnpm@10.33.0 exec tsx scripts/escrow/cli.ts idl-policy \
  --idl target/idl/calledit_escrow.json

npx -y pnpm@10.33.0 exec tsx scripts/escrow/cli.ts verify-release \
  --manifest release-manifest.json \
  --program-so target/deploy/calledit_escrow.so \
  --idl target/idl/calledit_escrow.json \
  --source programs/calledit-escrow \
  --lock Cargo.lock \
  --rpc "$SANITIZED_RPC_URL"

npx -y pnpm@10.33.0 exec tsx scripts/escrow/cli.ts ops-status \
  --input sanitized-ops-status.json

npx -y pnpm@10.33.0 exec tsx scripts/escrow/cli.ts mainnet-gate \
  --evidence sanitized-mainnet-evidence.json
```

Exit codes are stable: `0` passed, `2` bad command usage, `3` invalid or unsafe
input, `4` identity/build/IDL mismatch, `5` RPC unavailable or malformed, `6`
mainnet evidence incomplete, `7` operations unhealthy, and `8` unexpected
internal failure. Credential-like fields are rejected. Errors redact URLs and
credential-looking values.

The files under `scripts/escrow/fixtures` are fake examples. They are not
release evidence, multisig approval, audit closure, or authority configuration.

## Release Manifest Procedure

1. Build the same commit twice in isolated pinned environments.
2. Generate one provenance manifest for each build. The manifest binds the
   commit, program ID, SBF bytes, IDL bytes, source tree, and `Cargo.lock`.
3. Require `compare-builds` to report exact equality.
4. Generate the deployed release expectation from approved public values only.
   Do not include RPC credentials, wallet files, tokens, Telegram init data, or
   signer material.
5. Run `verify-release` against a finalized RPC endpoint. It checks the cluster
   genesis, executable program and ProgramData account, upgrade authority,
   config and oracle PDAs, decoded config values, exact 2-of-3 oracle set,
   separate authorities, classic token program, canonical USDC mint, and six
   decimals.
6. Run the IDL policy against the exact deployed IDL. Any generic/admin vault
   withdrawal or missing claim, claim-for, void, timeout-void, or lot-close path
   blocks release.
7. Archive sanitized output and its SHA-256 digest in the evidence package.

For mainnet, all evidence in `mainnet-evidence.schema.json` is mandatory. The
gate requires local SOL/USDC adversarial tests, real devnet SOL/USDC E2E,
engine-down direct claim, paused timeout void, relayer recovery, legacy audit,
seven distinct drift-clean UTC days, closed independent and external review,
multisig control, an allowlisted low-cap canary, and explicit approval scoped to
`mainnet escrow canary value enablement`. Passing the gate does not deploy.

## Routine Reconciliation

Produce a sanitized snapshot conforming to `ops-status.schema.json`. Values are
atomic integers as decimal strings. For each asset:

```text
vault balance = calculated outstanding liability + expected residual
```

Run `ops-status` after every deployment, authority/config change, indexer
recovery, settlement incident, and at least daily during devnet soak or mainnet
canary. Any drift, identity mismatch, signer problem, dead/stale relayer job,
cursor lag, claim backlog, fee reserve breach, or legacy liability mismatch is
an unhealthy result and disables new market intake.

## Pause Intake, Preserve Recovery

Use the pause authority only to stop new market creation and new positions.
Pause must not disable settlement, signed void, permissionless timeout void,
claim, claim-for, or account closure.

1. Disable new escrow groups and market creation at the engine first.
2. Submit the reviewed pause action through the configured authority process.
3. Verify the config account with `verify-release` using an expectation with
   `paused: true`.
4. Run direct claim and timeout-void probes while paused.
5. Reconcile every open market and both assets.
6. Unpause only after the incident owner, program owner, and operations owner
   approve the same written recovery record.

If recovery fails while paused, keep intake disabled. Do not rotate users,
rewrite entitlements, sweep vaults, or use an upgrade to change settled results.

## Signer Disagreement Or Outage

1. Stop new market creation; existing claims and timeout recovery remain open.
2. Compare each signer's fixture, result, evidence hash, oracle epoch, issued
   time, expiry, cluster genesis, program ID, config PDA, and market address.
3. Quarantine a signer that differs. Never combine signatures over different
   message bytes.
4. If fewer than two independent signers agree, do not settle. Wait for the
   immutable timeout and use permissionless timeout void when eligible.
5. Rotate an oracle set only through the approved config authority. Existing
   markets remain pinned to their original epoch.
6. Record disagreement and recovery artifacts in the next operations snapshot.

## RPC, Relayer, Or Indexer Outage

RPC failure is unknown state, not transaction failure. Never re-sign or rebuild
a user-authorized placement merely because a request timed out.

1. Stop new signing sessions and market creation on identity mismatch or loss of
   finalized reads.
2. Query the original signature through an independently configured RPC with
   the same genesis before any retry.
3. Resume a persisted signed transaction only if its exact message, signatures,
   blockhash lifetime, program, accounts, amount, asset, nonce, epoch, and
   expiry remain valid. Otherwise expire it and request a fresh user signature.
4. Restart the relayer from its durable outbox. Dead jobs or old unknown jobs
   keep readiness closed.
5. Rebuild the indexer from finalized chain events and its last verified cursor.
   Do not treat the database mirror as settlement truth.
6. Reconcile every touched market before reopening intake.

## Direct Claim And Timeout Recovery

The owner destination is fixed by the position account. A relayer may pay fees,
but cannot substitute the SOL owner or canonical USDC ATA.

1. Obtain the public market and position accounts from finalized RPC.
2. Build `claim_position` for the owner or `claim_position_for` with the owner
   destination unchanged. Verify the full instruction before signing/submitting.
3. If a market is unresolved after its immutable deadline, build
   `timeout_void`. It is permissionless and requires no pause authority.
4. After void finalization, claim each aggregate position exactly once.
5. Keep public direct-claim instructions available even when the engine, bot,
   web app, relayer, or indexer is unavailable.

Never accept a support-provided replacement destination, seed phrase, private
key, Telegram code, Privy token, or raw authentication payload.

## Legacy Withdrawal-Only Wind-Down

`WAGER_CUSTODY_MODE=legacy|escrow` remains a hard boundary. Escrow launch does
not migrate balances.

1. Disable new legacy deposits and new legacy markets.
2. Keep legacy settlement, reconciliation, support, and withdrawals running.
3. Reconcile recorded liability to ledger liability and verify treasury
   coverage. Any mismatch is a release blocker.
4. Let each user withdraw legacy funds to their verified Privy wallet. Never
   create an escrow position or transfer to a market vault on the user's behalf.
5. Preserve ledger, withdrawal outbox, and transaction evidence for the full
   recovery window.
6. Remove legacy custody code only after open markets are zero, liabilities are
   zero or separately reserved, and operations approves the archive.

## Rollback And Escalation

Confirmed transactions cannot be rolled back. Operational rollback means stop
new groups, markets, signing sessions, and positions; preserve settlement,
voids, claims, and refunds; then reconcile every market. Do not attempt to
reverse settlements or auto-migrate funds.

Escalate immediately for nonzero drift, unauthorized authority/config change,
program/IDL/SBF mismatch, destination substitution, signer equivocation,
duplicate value movement, underfunded vault or legacy treasury, or inability to
claim/timeout-void while paused. Preserve transaction signatures, slots,
sanitized account snapshots, build manifests, and hashes. Do not place secrets
in tickets, chat, logs, evidence JSON, or workflow inputs.

Mainnet deployment, authority rotation, real-fund movement, and setting
`WAGER_CUSTODY_MODE=escrow` on mainnet require a separate explicit user and
operations approval after the verification-only workflow passes. The workflow
itself has no deployment step.
