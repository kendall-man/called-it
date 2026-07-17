# ORACLE SIGNER

## Scope

Isolated Railway service that verifies canonical attestation requests before signing.

## Map

- `env.ts`: strict deployment/network/key contract.
- `contracts.ts`, `verifier.ts`: accepted payload and semantic verification.
- `journal.ts`: durable decision record; no secret payload logging.
- `server.ts`, `readiness.ts`: narrow HTTP surface and fail-closed health.
- `main.ts`: composition only.

## Rules

- Never accept arbitrary messages or generic signing requests.
- Recompute canonical bytes and domain separation locally.
- Verify program/network/market/event epoch and signer role before signing.
- Journal accepted/rejected request identity without private keys or full credentials.
- Readiness fails if identity, RPC network, or journal guarantees are uncertain.
- Keep this service independent from Telegram and web user input.
- Rotate signer identity only through the documented deployment gate; epoch changes are explicit.
- Tests use synthetic keys and payloads. Never load production key material into a fixture.

## Deployment

`railway.json` is service-local. Health is not proof of signing readiness; check the readiness
contract and journal availability before routing engine attestation traffic.

## Checks

```bash
pnpm --filter @calledit/oracle-signer typecheck
pnpm --filter @calledit/oracle-signer test
```
