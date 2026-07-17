# ESCROW RUNTIME

## Scope

Production custody orchestration: placement sessions, relayers, attestations, finality,
settlement projection, recovery, readiness, and reconciliation. Parent engine rules apply.

## Map

- `placement-*`: create opaque signing sessions, validate signed callbacks, enqueue once.
- `market-*`: initialize and relay canonical escrow market accounts.
- `event-*`, `attestation-*`: canonical TxLINE evidence and signer requests.
- `position-activation-*`: finalized-chain activation, never optimistic balance mutation.
- `terminal-workflow-*`: settlement/void orchestration from durable terminal facts.
- `recovery-*`, `reconciler.ts`: resume persisted jobs; chain finalized state wins.
- `readiness*.ts`, `solana-readiness.ts`: fail-closed production gates.
- `job-state.ts`, `runtime-lifecycle.ts`: legal transitions and drain ordering.

## Invariants

- Use `@calledit/escrow-sdk` codecs and account derivations; no local protocol forks.
- Persist intent/job state before broadcast. Idempotency keys survive restart and retry.
- Re-broadcast identical signed bytes. Re-sign only after full-history status proves absent
  and the blockhash is expired.
- Validate network, program, mint, owner, group allowlist, market identity, side, amount,
  cutoff, and oracle epoch before accepting user-signed bytes.
- Never log tokens, wallet/provider IDs, signed bytes, RPC credentials, or raw Telegram IDs.
- Public/group text exposes bounded aliases and status, not signing or custody internals.
- Recovery is explicit and resumable; normal readiness must not silently invoke it.

## Checks

```bash
pnpm --filter @calledit/engine exec vitest run src/escrow
pnpm --filter @calledit/engine typecheck
pnpm --filter @calledit/escrow-sdk test
```

Do not weaken finality or readiness to make a test green. Extend fakes with the same durable
contract used by production.
