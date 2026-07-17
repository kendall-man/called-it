# ESCROW RECOVERY CLI

## Scope

Operator-only recovery executable for durable escrow jobs. Not a web service or normal engine path.

## Rules

- Parse credentials in `credentials.ts`; never print values or embed them in reports.
- Query finalized/full-history state before deciding retry, confirm, refund, or manual review.
- Operations are resumable and idempotent; a repeated command converges.
- Preserve already signed bytes when safe; never invent a replacement signature blindly.
- Return stable error codes from `errors.ts`; operator output stays redacted.
- Keep RPC effects behind `rpc.ts` so tests cover every decision edge.

## Map

- `cli.ts`, `main.ts`: argument parsing and executable boundary.
- `recovery.ts`: decision state machine; keep side effects ordered and explicit.
- `credentials.ts`: redacted credential loading.
- `rpc.ts`: finalized/full-history chain reads and bounded writes.
- `errors.ts`: stable operator-facing failure taxonomy.

Recovery output is evidence, not an application log. Include job/signature references only when
already public and required for operator action.

## Checks

```bash
pnpm --filter @calledit/escrow-recovery typecheck
pnpm --filter @calledit/escrow-recovery test
pnpm --filter @calledit/escrow-recovery build
```
