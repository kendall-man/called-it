# MOCKLINE STAGING TWIN

## Scope

Opt-in deterministic TxLINE-compatible server for staging journeys. It must never activate from
production defaults.

## Map

- `server.ts`: supported TxLINE-compatible HTTP/SSE endpoints.
- `store.ts`, `materialize.ts`: deterministic authored event state.
- `scripts/`: synthetic match narratives; no licensed/live TxLINE payloads.
- `constants.ts`, `types.ts`: staging protocol contract.

## Rules

- Gate use through explicit staging commands/environment; production engine URLs remain external.
- Fixtures are synthetic/authored and credential-free.
- Preserve stable fixture IDs, sequence order, replay timing, and Last-Event-ID behavior.
- Mock only the football feed. Telegram, database, asset accounting, and settlement paths stay real.
- Chain-proof claims must degrade honestly when synthetic evidence cannot be verified.

## Profile

Use root `staging:*` scripts and `.env.staging.example`. Never point the profile at production
Supabase, Telegram, or signer credentials. `STAGING.md` is the operator runbook.

## Checks

```bash
pnpm --filter @calledit/mockline test
pnpm --filter @calledit/mockline typecheck
```
