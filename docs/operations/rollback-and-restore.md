# Forward-Only Rollback And PITR Restore Rehearsal

This runbook covers an application rollback and a point-in-time recovery (PITR)
rehearsal. It is deliberately forward-only:

- Do not run down, reverse, or ad-hoc schema migrations.
- Do not restore over the live database.
- Do not point a restored environment at production Telegram, Solana, provider,
  or delivery credentials.
- Do not mark a rehearsal successful from a local fixture or a simulated provider
  action. Provider restore evidence is produced only by an authorized operator
  outside source control.

The evidence report is a redacted JSON document. Validate it from the repository
root with:

```sh
npx -y pnpm@10.33.0 exec tsx scripts/verify-restore-report.ts <redacted-report.json>
```

The command writes `{ "schema_version": 1, "status": "valid" }` to stdout
only when every acceptance condition passes. Invalid reports return a non-zero
status and JSON violations on stderr. The validator does not connect to a
provider, execute PITR, inspect credentials, or alter an environment.

## Roles And Decisions

| Decision point | Owner | Deadline | Continue only when | Stop / escalate when |
| --- | --- | --- | --- | --- |
| Declare rollback or restore incident | Incident commander | Immediately | Scope and affected release are recorded | Ownership or customer impact is unclear |
| Disable write paths | Engine owner | Before any deployment | All write flags are confirmed off | A write path, worker, or webhook remains active |
| Forward-only application rollback | Release owner | Within 15 minutes of declaration | Previous release is compatible with all disabled flags and current schema | Previous release requires a schema reversal or enabled incompatible flag |
| Create isolated PITR target | Database owner | Within 20 minutes | Separate project/instance, no live delivery, no production credentials | Target shares the live project, credentials, or webhook |
| Compare restored state | Database owner and finance owner | Before RTO expiry | All required hashes, totals, digests, and invariants match | Any mismatch, incomplete comparison, or raw sensitive data |
| Reconcile workers | Engine owner | Before acceptance | Every durable queue is reconciled with side effects blocked | Lease, idempotency, ledger, proof, or queue state is unexplained |
| Accept or reject rehearsal | Incident commander | `recovery_completed_at + 20 minutes` | RPO <= 15 minutes and RTO <= 60 minutes | Either objective fails or any control remains unsafe |

The incident commander records `accepted` only after all comparison and worker
gates pass. Otherwise record `rejected`, keep write paths off, and open a
forward corrective-release decision.

## A. Freeze The Live System

1. Create an incident record with the release ID, intended recovery point, and
   start time. Record only references and digests in the evidence report.
2. Turn off write-capable flags first. At a minimum block new writes, intake,
   settlement, proof submission, and withdrawals. Confirm the controls are
   false from the control plane and that no new application mutations are
   accepted.
3. Stop worker claiming after the flags are off. Capture the durable queue
   snapshot: ready, leased, dead-letter, and sorted job-ID digest for Telegram
   ingress/outbound, settlement, proof, and proof-submission work.
4. Stop live inbound delivery before changing application deployments. Preserve
   pending Telegram updates; do not discard them to make a backlog look clean.
   Record that live webhook delivery is disabled.
5. Capture the current release IDs and a SHA-256 manifest of every tracked SQL
   migration. Treat the migration sequence and hashes as part of the database
   identity, not a deployment convenience.

## B. Forward-Only Application Rollback

1. Keep all write flags disabled. Deploy only the prior application release
   that is compatible with the retained schema while flags are off. The
   rollback applies to engine, web, and concierge releases as applicable; it
   never changes the live database schema.
2. Do not deploy an older application if it requires a removed column, an old
   data shape, a schema reversal, or any enabled feature flag that it cannot
   safely honor. Keep traffic stopped and create a forward corrective release
   instead.
3. Run release readiness checks with writes disabled. Confirm the engine is the
   only writer, the public web surface remains read-only, and concierge calls
   only the engine API.
4. A live webhook may be registered again only after all of the following are
   true: one intended engine ingress is healthy, authorization and source
   verification are healthy, no isolated target is registered, write flags are
   intentionally set for the desired state, and the durable queue recovery
   plan is approved. Registering a webhook is the final live cutover action.

If the rollback is a rehearsal rather than a live incident, leave the live
webhook disabled only for the approved rehearsal window and use no restored
target for live ingress.

## C. Isolated PITR Restore

1. The database owner creates a new, isolated provider project or database
   instance. It must have an independent identifier, be marked non-live, block
   external delivery, and have no production application credentials attached.
   A clone inside the live project is not isolated.
2. The authorized database owner performs the provider PITR action in the
   provider console or credentialed provider CLI. Credentials stay outside the
   repository and report; do not preserve them in shell history or terminal
   captures. Source control must not contain a command that purports to perform
   the restore.
3. Record external-credential evidence in the report only as an operator-
   controlled provider name, timestamp, completion result, and non-secret
   ticket/audit reference. Set `provider_restore_evidence.execution` to
   `external_credential` only after the provider reports completion. A mock,
   dry run, local snapshot, or manually written completion claim is not PITR
   evidence.
4. Do not attach the restored target to production webhooks, Telegram delivery,
   Solana signing, or public traffic. Start no externally-effecting workers.
5. Do not mutate the restored database to make comparisons pass. If the restore
   point is wrong or a required comparison fails, destroy the isolated target
   after preserving redacted evidence and repeat from a newly isolated target.

## D. Required Comparison Gates

Generate each comparison independently on the source snapshot and restored
target. Use row totals and SHA-256 digests of sorted, canonical identifiers;
never include raw Telegram data, user IDs, wallet addresses, URLs with
credentials, tokens, private keys, or connection strings in the report.

The report must include all of the following with source/target equality and
`status: "match"`:

| Area | Required evidence |
| --- | --- |
| Migrations | Non-empty ordered source and target `{ name, sha256 }` manifests; exact names, count, and hashes match. |
| Schema | Canonical schema checksum for source and target. |
| Row totals | `groups`, `markets`, `positions`, `settlements`, `ledger_entries`, `proofs`, `telegram_updates`, and `proof_submission_outbox`. |
| Identifier sets | The same scopes as row totals, each with total and digest of its sorted canonical IDs. |
| Idempotency | Total, immutable key-set digest, and zero duplicates on both sides. |
| Ledger | Row total, entry-set digest, debit lamports, and credit lamports. |
| Liability | Row total, liability-ID digest, and outstanding liability lamports. |
| Proofs | Row total, proof-ID digest, and `pending`, `verified`, `failed`, and `unavailable` totals. |
| Durable queues | Ready, leased, dead-letter totals and job-ID digest for `telegram_ingress`, `telegram_outbound`, `settlement`, `proof`, and `proof_submission`. |
| Invariants | Pass on both sides: no duplicate idempotency keys; append-only balanced ledger; liability reconciliation; immutable/verifiable proofs; recoverable queue leases. |

Any missing scope, checksum or total mismatch, invariant failure, or raw
secret-like field is a failed rehearsal. Do not waive a mismatch by copying the
source value into the target evidence.

## E. Controlled Worker Reconciliation

1. Keep external side effects blocked in the isolated target. Workers may read
   durable state only after the comparison gates pass.
2. For each required queue, reconcile stale leases according to its bounded
   recovery policy. Use the durable idempotency keys; do not create replacement
   ledger, settlement, or proof rows manually.
3. Reconcile Telegram ingress and outbound state without registering a live
   webhook or sending externally. Reconcile settlement, proof, and
   proof-submission work without chain signing or proof delivery.
4. Record `reconciled` and `external_side_effects: "blocked"` for each worker.
   An unexplained queue delta, duplicate idempotency key, changed ledger total,
   altered liability, or proof state drift is a rejection.
5. Destroy or retain the isolated target under the incident retention policy
   only after the final decision. It must never be promoted to production.

## F. Acceptance And Report Contract

`timing.source_last_consistent_at`, `timing.restore_started_at`, and
`timing.recovery_completed_at` are ISO-8601 timestamps. The validator measures
RPO as `restore_started_at - source_last_consistent_at` and RTO as
`recovery_completed_at - restore_started_at`; reported minute fields must equal
those measurements. Acceptance requires RPO <= 15 minutes and RTO <= 60
minutes.

The top-level report contract is version `1` and requires these sections:

```text
schema_version, report_id, redaction, source, target, timing,
provider_restore_evidence, safe_state, app_rollback, migration_hashes, schema,
row_totals, identifier_comparisons, idempotency, ledger, liability, proofs,
queues, invariants, worker_reconciliation, decision
```

Key safe-state values are exact:

```json
{
  "redaction": { "status": "redacted" },
  "target": {
    "classification": "isolated_restore",
    "reference": "[REDACTED]",
    "is_isolated": true,
    "is_live": false,
    "independent_project": true,
    "production_credentials_attached": false,
    "external_delivery": "blocked"
  },
  "provider_restore_evidence": {
    "execution": "external_credential",
    "result": "completed",
    "provider": "managed-postgres",
    "evidence_reference": "ticket:restore-YYYYMMDD-001",
    "observed_at": "YYYY-MM-DDTHH:MM:SS.000Z"
  },
  "app_rollback": {
    "mode": "forward_only",
    "schema_action": "none",
    "flags_disabled_before_deploy": true,
    "release_compatible_with_enabled_flags": false
  }
}
```

`safe_state.feature_flags` must include `writes_enabled`, `intake_enabled`,
`settlement_enabled`, `proof_submission_enabled`, and `withdrawals_enabled`,
all `false`. Its webhook state must be `production_delivery: "disabled"`,
`isolated_target_registration: "absent"`, and
`pending_update_disposition: "preserved"`. `safe_state.external_side_effects`
must be `"blocked"`.

The final `decision` names the owner, a deadline timestamp, and `accepted` only
after all gates pass. The test-only fixture in
`scripts/restore/report-fixture.ts` is the complete redacted shape exercised by
the validator; it is not evidence of a real provider restore.

## Failure Handling

| Failure | Immediate action | Next decision |
| --- | --- | --- |
| Write flag, webhook, or external worker remains active | Stop delivery and side effects; retain safe state | Incident commander decides whether to extend outage or deploy a forward fix |
| Old application is schema/flag incompatible | Do not deploy it | Release owner produces a forward corrective release |
| Provider restore cannot be independently evidenced | Reject rehearsal | Database owner repeats it using authorized external credentials |
| Schema, migration, total, digest, or invariant mismatch | Do not reconcile toward the expected value | Database and finance owners investigate source/target divergence |
| RPO > 15 or RTO > 60 | Reject rehearsal | Incident commander opens resilience remediation with a dated retest |
| Redaction validator fails | Remove or redact the offending field and regenerate evidence | Database owner re-runs validation before review |

This runbook is complete only when the evidence report validates, the incident
commander records the acceptance or rejection decision, and no isolated
resource can receive live traffic or credentials.
