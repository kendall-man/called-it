# ESCROW SDK

## Scope

Canonical TypeScript protocol layer shared by engine, web, signer, recovery, and integration tests.
Read `PROTOCOL.md` before changing encodings or account semantics.

## Invariants

- Canonical JSON, Borsh layouts, discriminators, PDA derivations, and instruction account order
  are protocol compatibility boundaries.
- Keep codecs deterministic and environment-free. No RPC, clocks, or process env in core modules.
- Verify every account owner/program/mint/market link before constructing or accepting a transaction.
- Use bigint for lamports/token atomic units and payout reference math.
- Version protocol changes; never reinterpret an existing byte layout.
- Update vectors under `vectors/` and differential/decoder tests with any intentional change.
- Browser-consumed exports remain isomorphic.

## Map

- `schema.ts`, `domain.ts`: public types and validation.
- `codec.ts`, `borsh.ts`, `instruction-codec.ts`, `account-decoders.ts`: wire formats.
- `addresses.ts`, `accounts.ts`, `instruction-accounts.ts`: identity and account constraints.
- `transactions.ts`, `instructions.ts`: builders.
- `attestations.ts`, `evidence.ts`, `verification.ts`: signed evidence boundary.

## Checks

```bash
pnpm --filter @calledit/escrow-sdk test
pnpm --filter @calledit/escrow-sdk typecheck
pnpm --filter @calledit/escrow-sdk build
```
