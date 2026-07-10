# Environment Contract

This document is the operational source of truth for runtime configuration. The
root `.env.example` is a complete inventory; each app-local `.env.example` is
the deployable subset for that service. Development may use untracked local env
files. Staging and production must use the platform secret manager and must not
ship env files.

## Environment isolation

Development, staging, and production use different Supabase projects, Telegram
bots and webhook secrets, Railway services, Vercel environments, route tokens,
analytics keys, session masters, and devnet treasury keypairs. A staging
resource identifier must never equal its production counterpart. Production
data must not be copied into staging.

| Configuration | Engine | Concierge | Web | Owner |
| --- | --- | --- | --- | --- |
| `DEPLOYMENT_ENV` | required | required | `NODE_ENV` is supplied by Next | release operator |
| Telegram bot token, username, webhook secret | required | required | username is public only | Telegram operator |
| `ENGINE_CONCIERGE_TOKEN` | accepts | sends | forbidden | platform security |
| `ENGINE_TELEGRAM_TOKEN` | accepts | sends | forbidden | platform security |
| `ENGINE_OPS_TOKEN` | accepts | forbidden | forbidden | operations lead |
| `ENGINE_CONCIERGE_TOKEN_SHA256` | forbidden | forbidden | audits | platform security |
| `ENGINE_TELEGRAM_TOKEN_SHA256` | forbidden | forbidden | audits | platform security |
| `ENGINE_OPS_TOKEN_SHA256` | forbidden | audits | audits | operations lead |
| `ENGINE_PRIVATE_API_URL` | n/a | required | forbidden | Railway operator |
| `CONCIERGE_WALLET_API_URL` | forbidden | n/a | server-only | Vercel operator |
| `WEB_CONCIERGE_TOKEN` | forbidden | accepts | sends, server-only | platform security |
| `WEB_CONCIERGE_TOKEN_SHA256` | audits | forbidden | forbidden | platform security |
| account session keyring | forbidden | required when Mini App is on | forbidden | platform security |
| `ANALYTICS_HMAC_SECRET` | required | required | server-only when wallet bridge is configured | privacy owner |
| Supabase service role | required | forbidden | forbidden | database operator |
| Supabase anon values | forbidden | forbidden | optional public pair | database operator |
| wager treasury keypair | required when stake intake is on | forbidden | forbidden | treasury operator |
| public Telegram username/start payload | forbidden | forbidden | required in production | web release owner |

`NEXT_PUBLIC_TELEGRAM_STARTGROUP` is exactly `calledit_v1`. Changing the
payload requires a new version and matching bot support; a stale or unversioned
value fails the production build. No token, HMAC key, session key, service-role
key, or treasury key may use a `NEXT_PUBLIC_` name.

## Route credentials

The three engine route tokens are at least 32 characters and pairwise distinct.
They grant only their named route scope. `WEB_CONCIERGE_TOKEN` is also distinct
and grants no engine route. A shared engine bearer and public engine URL are not
part of the contract.

Deployment preflight computes lowercase SHA-256 hex fingerprints for cross-scope
uniqueness checks. Engine receives only `WEB_CONCIERGE_TOKEN_SHA256`, concierge
receives only `ENGINE_OPS_TOKEN_SHA256`, and web receives only the three
`ENGINE_*_TOKEN_SHA256` values. These fingerprints are not bearer credentials
and must never replace the raw token in an Authorization header.

For the initial split, provision all route credentials with intake disabled,
deploy the accepting engine, then deploy the concierge callers. Verify a
negative request with a different scope and a matching request before enabling
traffic. A later replacement also disables intake and updates the accepting
service before its caller; the contract does not claim a dual-token overlap.
Never put a token in a URL, query string, body, log, health response, deployment
manifest, or evidence file. Evidence may record fingerprint variable presence
and equality or inequality outcomes, never raw token material.

Exact engine route scopes:

| Scope | Routes |
| --- | --- |
| Public | `GET /api/live`, `GET /api/ready` |
| Concierge | `GET /api/groups/:chatId/snapshot`, `GET /api/groups/:chatId/users/:userId/wallet`, `GET /api/markets/:marketId`, `GET /api/fixtures`, `POST /api/quote` |
| Telegram | `POST /api/telegram-ingress` |
| Operations | `GET /api/ops/status` |

The current Telegram ingress adapter is transitional until durable ingress
queues land. It still acknowledges only after the typed update boundary and bot
handler resolve; this is not evidence of durable persistence.

## Session keyring

`ACCOUNT_SESSION_KEY_CURRENT` and `ACCOUNT_SESSION_KEY_PREVIOUS` are canonical
base64 encodings of exactly 32 random bytes. KIDs are non-secret deployment
metadata and must not encode key material. The concierge derives two 32-byte
subkeys from each master with HKDF-SHA256 and these exact info labels:

- JWE: `calledit/account-jwe/v1`
- CSRF: `calledit/account-csrf/v1`

Only current-derived keys encrypt sessions and sign CSRF values. Current and
previous-derived keys may verify/decrypt only while
`ACCOUNT_SESSION_KEY_PREVIOUS_EXPIRES_AT` is in the future. The parser rejects
an expiry more than ten minutes ahead, an expired previous key, duplicate
masters or KIDs, and any incomplete current/previous tuple.

Rotation order:

1. Generate a new 32-byte master and a new non-secret KID in the secret manager.
2. Move the old current master/KID to the previous fields.
3. Set the previous expiry to no more than ten minutes from deployment start.
4. Deploy the new current plus bounded previous tuple.
5. Verify new sessions carry the current KID and an old session is accepted.
6. At expiry, remove all three previous fields and redeploy.

Logs, readiness, and evidence may contain only current KID, previous KID, and
previous acceptance deadline. They must never serialize masters or derived JWE
or CSRF bytes.

## Rollout switches

The switches are independent and parse only the literal strings `true` and
`false`:

| Switch | Default | Authority |
| --- | --- | --- |
| `WALLET_MINIAPP_ENABLED` | `false` | exposes account/wallet entry surfaces |
| `STAKE_ACCEPTANCE_ENABLED` | `false` | admits new positions after readiness and coverage gates |
| `STARTER_GRANTS_ENABLED` | `false` | permits the database starter path after stake intake is safe |

Starter grants cannot be enabled while stake acceptance is disabled. Stake
acceptance requires wager mode, a dedicated treasury keypair, and
`TREASURY_COVERAGE_ENFORCED=true`. The grant amount, total cap, grant count,
used budget, and remaining budget are database state and must never be env
variables.

## Readiness and queue bounds

The example values are the initial beta contract, not permissive fallbacks:

| Variable | Initial value | Constraint |
| --- | ---: | --- |
| `READINESS_ENGINE_TIMEOUT_MS` | 3000 | concierge engine check only; less than overall check budget |
| `READINESS_CHECK_TIMEOUT_MS` | 5000 | less than queue lease and shutdown drain |
| `QUEUE_LEASE_MS` | 30000 | greater than readiness check budget |
| `QUEUE_MAX_ATTEMPTS` | 8 | integer from 1 through 100 |
| `QUEUE_RETRY_BASE_MS` | 500 | no greater than retry maximum |
| `QUEUE_RETRY_MAX_MS` | 30000 | bounded retry ceiling |
| `READINESS_FEED_MAX_AGE_MS` | 60000 | active-pricing feed age |
| `READINESS_WORKER_MAX_AGE_MS` | 30000 | Telegram, proof, and settlement worker heartbeat age |
| `READINESS_INGRESS_MAX_AGE_MS` | 30000 | oldest ingress work age |
| `READINESS_PROOF_MAX_BACKLOG` | 100 | maximum ready proof jobs |
| `READINESS_PROOF_MAX_OLDEST_AGE_MS` | 600000 | oldest proof work age |
| `READINESS_SETTLEMENT_MAX_BACKLOG` | 100 | maximum ready settlement jobs |
| `READINESS_SETTLEMENT_MAX_OLDEST_AGE_MS` | 120000 | oldest settlement work age |
| `SHUTDOWN_DRAIN_TIMEOUT_MS` | 12000 | greater than readiness budget and at most 15000 |

Railway health checks use `/api/ready` with a 30-second platform timeout. This
is longer than the internal readiness budget. `/api/live` proves only process
liveness. Health responses contain stable reason codes, never values or raw
dependency errors. Route internals are owned by the health implementation.

## Failure behavior

Every app parses untrusted env input before serving work. Invalid startup errors
contain sorted variable names only. They never contain values. Repeating an
invalid startup produces the same message; Railway bounds restart retries so a
bad configuration cannot loop indefinitely. A redacted deployment checklist
records variable presence, switch state, KIDs, thresholds, resource IDs, and
source commit, never secret values.
