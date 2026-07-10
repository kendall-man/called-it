# Dependency Risk Policy

## Gate

The release policy evaluates the production JSON report from `pnpm audit --prod --json`.
Critical, high, and moderate advisories fail closed unless a complete, unexpired waiver
matches the advisory identifier, affected package, and vulnerable version range exactly.
An advisory without a waiver is considered reachable. A lower severity advisory is reported
but does not block this gate.

`scripts/security/dependency-policy.mjs` writes one machine-readable JSON result to stdout.
It exits `1` for policy failures and `2` for malformed input. The result is suitable for
release evidence consumers without a manual approval step.

## Waivers

`security/dependency-waivers.json` is a strict JSON document. Its only top-level fields are
`schema_version` and `waivers`. Unknown fields fail validation. A waiver is temporary and
must contain exactly these fields:

```json
{
  "advisory_id": "GHSA-1234-5678-9abc",
  "package_name": "affected-package",
  "version_range": "<2.0.0",
  "reachability": {
    "status": "reachable",
    "basis": "shipped_workspace",
    "justification": "A production import path reaches the vulnerable package.",
    "audit_paths": ["apps__engine>affected-package"]
  },
  "affected_paths": ["apps/engine/src/main.ts"],
  "compensating_control": "A release-blocking remediation issue is tracked.",
  "owner": "security@example.invalid",
  "issue_url": "https://github.com/example/project/issues/1",
  "evidence_ref": "git:0123456789abcdef0123456789abcdef01234567",
  "expires_on": "2026-08-10"
}
```

`reachability.status` is either `reachable` or `not_reachable`. A reachable waiver must use
the `shipped_workspace` basis. A non-reachable waiver must use exactly one of `fixture_only`,
`test_only`, or `dead_package`, and must cite that exclusion in its justification and
`affected_paths`. `audit_paths` must be the exact, sorted dependency paths emitted by the
matching audit entry; path-mismatched waivers fail rather than acting as a blanket exemption.
A reachable waiver is only for a no-patch transitive exception with a compensating control.
Both kinds expire on the stated UTC date and may not be more than 30 days from policy
evaluation. Expired, malformed, duplicate, path-mismatched, or orphaned waivers fail closed.

## Lock Integrity

`scripts/security/lock-integrity.mjs` verifies that the pnpm v9 lock format is valid, every
workspace manifest has one exact importer, each importer specifier matches its manifest,
and every registry package has an SRI integrity hash. CI also performs
`pnpm install --frozen-lockfile`, which verifies the package-manager installation contract.

Run the focused local checks with:

```sh
node --test scripts/security/dependency-policy.test.mjs scripts/security/lock-integrity.test.mjs
node scripts/security/lock-integrity.mjs
```

The independent security workflow runs the frozen install, lock integrity verifier,
production advisory policy, and a full-history Gitleaks scan. The Gitleaks action is pinned
to commit `ff98106e4c7b2bc287b24eaf42907196329070c7` (upstream `v2.3.9`).

## Required Shared Integration

The primary CI chain remains `package.json#verify`, `.github/workflows/ci.yml`, and
`scripts/check-workflow.ts`. Add the dependency-policy command to `verify`, then make the
workflow checker reject a `verify` command that omits it and validate this security workflow
alongside `ci.yml`. Those shared seams are intentionally outside this bounded implementation.
