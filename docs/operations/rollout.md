# Disabled-First Rollout

This is the exact staging and production ordering for the direct-onboarding
configuration. Do not reorder or combine gates. Staging completes the same
sequence with isolated resources before production starts.

## Preflight

1. Select one reviewed commit and record its lockfile and migration checksums.
2. Prove staging and production resource IDs differ for Supabase, Telegram,
   Railway, Vercel, route credentials, session keys, analytics keys, and the
   devnet treasury.
3. Apply forward-only migrations with the database starter budget disabled.
4. Set `WALLET_MINIAPP_ENABLED=false`, `STAKE_ACCEPTANCE_ENABLED=false`,
   `STARTER_GRANTS_ENABLED=false`, and `TREASURY_COVERAGE_ENFORCED=false`.
5. Compute lowercase SHA-256 hex fingerprints for route-token uniqueness checks
   and set only the fingerprint variables needed by the opposite runtime.
6. Validate each service environment with the exact parser shipped in the
   selected commit. Stop on any named variable failure.
7. Parse all deployment JSON and confirm the commands and health paths match
   this document before deploying.

## Deployment order

1. Deploy engine.
2. Require `GET /api/live` to return 200.
3. Require `GET /api/ready` to return 200 with all capabilities intentionally
   disabled. A disabled capability is ready; a required dependency is not.
4. Run route-auth negatives: missing credentials are rejected and each valid
   credential is rejected outside its scope. Verify public access only for
   engine `GET /api/live` and `GET /api/ready`.
5. Deploy concierge.
6. Require concierge `GET /api/live` and `GET /api/ready` to return 200, with
   its private engine readiness check inside the configured timeout.
7. Build and deploy web from the same commit. The build must reject missing or
   stale Telegram username/start payload configuration.
8. Run read-only public smoke checks against the web deployment.
9. Register or update the Telegram webhook last, using the concierge HTTPS URL,
   secret header, and the exact allowed update set owned by Telegram ingress.
10. Verify webhook status and zero unexpected pending/error backlog.

Never enable a capability while either Railway service is not ready. Never set
the Telegram webhook before engine, concierge, and their private route are
verified.

## Capability order

1. Enable `WALLET_MINIAPP_ENABLED=true` in concierge and web only after the
   current session keyring, web bridge token, exact origins, and wallet API URL
   validate. Redeploy concierge before web. Verify current-KID session issuance
   and CSRF/JWE key separation.
2. Configure the engine wager module and dedicated treasury while
   `STAKE_ACCEPTANCE_ENABLED=false`.
3. Run the live treasury coverage equation and require nonnegative remaining
   coverage. Set `TREASURY_COVERAGE_ENFORCED=true`; require engine readiness.
4. Enable `STAKE_ACCEPTANCE_ENABLED=true` in engine, then mirror it in
   concierge/web presentation config. Require readiness and a controlled
   canary position before expansion.
5. Re-run the full coverage equation including the remaining starter budget.
6. Enable the authoritative database starter budget while
   `STARTER_GRANTS_ENABLED=false`.
7. Enable `STARTER_GRANTS_ENABLED=true` in engine last, then mirror it in
   concierge/web presentation config. Require readiness and one idempotent
   canary grant/position result.

The environment never sets grant lamports, cap lamports, maximum grants, or
remaining budget. Those values are read from the authoritative database.

## Abort order

On readiness, privacy, identity, queue, or solvency failure:

1. Set `STARTER_GRANTS_ENABLED=false` everywhere.
2. Set `STAKE_ACCEPTANCE_ENABLED=false` everywhere.
3. Set `WALLET_MINIAPP_ENABLED=false` if wallet/session behavior is implicated.
4. Disable the authoritative database starter budget.
5. Leave forward migrations in place and preserve durable work for drain or
   reconciliation.
6. Restore prior web, concierge, then engine deployments only after all intake
   switches are confirmed false.
7. Change the Telegram webhook only if the concierge endpoint or credential
   changed; verify webhook status afterward.

Removing the previous session key is not an abort step. Keep it only until its
recorded ten-minute deadline, then remove the entire previous tuple. Never
extend the deadline to rescue a rollout.

## Deployment manifest contract

The root `railway.json` starts the engine and checks `/api/ready` with a timeout
longer than the application check budget. `apps/concierge/railway.json` does the
same for Eve. Both use bounded restart retries. `apps/web/vercel.json` uses a
frozen lockfile and the app build command, whose Next config invokes the web env
parser. Vercel has no long-running process health command; public web smoke is a
separate promotion gate and must not be represented as engine readiness.
