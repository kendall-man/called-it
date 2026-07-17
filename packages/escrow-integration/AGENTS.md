# ESCROW INTEGRATION HARNESS

## Scope

Deterministic local-validator scenarios for placement, attestations, anti-snipe, settlement,
voiding, finalization, and crash recovery.

## Rules

- This package validates the real SDK/program contract; do not replace protocol behavior with mocks.
- Keep fixtures synthetic and keys test-only.
- Scenario phases are explicit and resumable; report the phase that failed.
- Exercise duplicate delivery, partial broadcast, restart, stale blockhash, wrong account, and
  adversarial ordering.
- Finalization checks use decoded chain accounts, not only transaction success.
- Local validator/Rust builds are opt-in because they consume disk; unit tests stay cheap.

## Map

- `scenario.ts`, `runtime.ts`, `bootstrap.ts`: harness lifecycle.
- `markets.ts`, `placements.ts`, `anti-snipe.ts`: setup and position paths.
- `settlement-phase.ts`, `void-phase.ts`, `finalization.ts`: terminal assertions.
- `recovery*.ts`, `adversarial.ts`: interruption and hostile cases.
- `account-decode.ts`: authoritative post-condition decoding.

## Checks

```bash
pnpm --filter @calledit/escrow-integration test
pnpm --filter @calledit/escrow-integration typecheck
```
