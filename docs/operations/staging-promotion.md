# Staging Promotion Contract

This is the source-controlled half of the staging gate. It validates a redacted
promotion input, records the local source/lock/migration hashes, and emits only
tagged fixture action plans. It does not provision resources, deploy a service,
apply a migration, set a webhook, or call a provider API.

## Required External Work

An operator with the relevant provider credentials must provision separate
staging and production Supabase projects, engine/concierge services, web
projects, Telegram bots, route-token sets, session-key sets, analytics keys,
and devnet treasuries. Record only redacted identifiers in the input below.

The operator must deploy engine, concierge, and web from one reviewed commit,
run fresh and upgrade migration checks, verify private engine routing and
readiness, and set the Telegram webhook last. These are external operations:
`scripts/staging/preflight.ts` intentionally reports them as
`external_credentials_required`; it cannot and does not simulate success.

## Promotion Input

Keep the JSON input and output evidence outside the repository. It contains no
credentials, but it identifies deployment resources. Print the machine-readable
schema when needed:

```sh
npx -y pnpm@10.33.0 exec tsx scripts/staging/preflight.ts --schema
```

Create an input using this shape. Each resource value must start with
`redacted:` and every staging value must differ from every production value.
All listed flags must be `false` before promotion.

```json
{
  "schema_version": 1,
  "resources": {
    "staging": {
      "supabase_project": "redacted:staging-supabase",
      "engine_service": "redacted:staging-engine",
      "concierge_service": "redacted:staging-concierge",
      "web_project": "redacted:staging-web",
      "telegram_bot": "redacted:staging-telegram",
      "route_token_set": "redacted:staging-route-tokens",
      "session_key_set": "redacted:staging-session-keys",
      "analytics_key_set": "redacted:staging-analytics",
      "devnet_treasury": "redacted:staging-treasury"
    },
    "production": {
      "supabase_project": "redacted:production-supabase",
      "engine_service": "redacted:production-engine",
      "concierge_service": "redacted:production-concierge",
      "web_project": "redacted:production-web",
      "telegram_bot": "redacted:production-telegram",
      "route_token_set": "redacted:production-route-tokens",
      "session_key_set": "redacted:production-session-keys",
      "analytics_key_set": "redacted:production-analytics",
      "devnet_treasury": "redacted:production-treasury"
    }
  },
  "deployments": {
    "staging": {
      "engine_private_origin": "http://engine-staging.railway.internal:8790",
      "web_public_origin": "https://staging.example.invalid",
      "telegram_webhook_origin": "https://staging-concierge.example.invalid",
      "disabled_first": {
        "WAGER_MODE_ENABLED": false,
        "STARTER_GRANTS_ENABLED": false,
        "WALLET_MINIAPP_ENABLED": false,
        "STAKE_ACCEPTANCE_ENABLED": false,
        "TREASURY_COVERAGE_ENFORCED": false
      }
    },
    "production": {
      "engine_private_origin": "http://engine-production.railway.internal:8790",
      "web_public_origin": "https://app.example.invalid",
      "telegram_webhook_origin": "https://concierge.example.invalid",
      "disabled_first": {
        "WAGER_MODE_ENABLED": false,
        "STARTER_GRANTS_ENABLED": false,
        "WALLET_MINIAPP_ENABLED": false,
        "STAKE_ACCEPTANCE_ENABLED": false,
        "TREASURY_COVERAGE_ENFORCED": false
      }
    }
  },
  "checklist": {
    "staging_isolated": true,
    "resource_ids_redacted": true,
    "fresh_migrations_verified": true,
    "upgrade_migrations_verified": true,
    "private_engine_route_verified": true,
    "readiness_verified": true
  },
  "builds": {
    "engine": { "source_commit": "40-character-commit-hash", "artifact_sha256": "64-character-sha256" },
    "concierge": { "source_commit": "40-character-commit-hash", "artifact_sha256": "64-character-sha256" },
    "web": { "source_commit": "40-character-commit-hash", "artifact_sha256": "64-character-sha256" }
  },
  "external_operations": {
    "resource_provisioning": "external_credentials_required",
    "webhook_deployment": "external_credentials_required"
  }
}
```

The engine origin must be a pathless Railway private origin. Web and Telegram
webhook origins must be pathless HTTPS origins. URLs with credentials, query
strings, or fragments are rejected. Build attestations must use the same commit
as the source evidence generated below.

## Preflight

Run preflight from the reviewed release checkout after committing the lockfile
and every migration. It fails when any on-disk migration is untracked or when
the lockfile or migrations have local modifications.

```sh
npx -y pnpm@10.33.0 exec tsx scripts/staging/preflight.ts \
  --config /secure/path/staging-promotion-input.json \
  --output /secure/path/promotion-manifest.json
```

The output contains the checked source commit, SHA-256 lockfile hash, and
SHA-256 checksum for each tracked SQL migration. It never reads environment
variables or includes credential values. A successful command is evidence of
the local contract only; it is not evidence that provider resources or the
Telegram webhook were provisioned.

## Tagged Fixtures

Use a single run tag in the form `calledit:staging:<run-id>`. Every fixture ID
must start with `stg_`, target `staging`, and set `synthetic` to `true`.

```json
{
  "target": "staging",
  "tag": "calledit:staging:release-001",
  "fixtures": [
    {
      "fixture_id": "stg_release_001_group",
      "target": "staging",
      "tag": "calledit:staging:release-001",
      "synthetic": true
    }
  ]
}
```

Generate the deterministic seed and cleanup plans with the same input shape:

```sh
npx -y pnpm@10.33.0 exec tsx scripts/seed-staging.ts \
  --input /secure/path/staging-fixtures.json > /secure/path/staging-seed-plan.json

npx -y pnpm@10.33.0 exec tsx scripts/cleanup-staging.ts \
  --input /secure/path/staging-fixtures.json > /secure/path/staging-cleanup-plan.json
```

Both commands are plan-only. There is no `--apply` option and no provider
adapter in this repository. A separately reviewed adapter must explicitly
target staging and execute the emitted action list. It must reject any untagged,
non-synthetic, or non-staging record, then verify that cleanup left rollout
controls unchanged.
