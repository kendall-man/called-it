# Observability Contract

`scripts/observability/contract.ts` is the source-only telemetry boundary for beta operations.
It serializes a fixed event-name and reason-code allowlist, fixed opaque identifier shapes,
HMAC pseudonyms for actor/group/source identifiers, and bounded numeric metadata only.

Raw claim text, Telegram payloads and identifiers, source keys, wallet addresses, signatures,
`initData`, credential values, session material, IP addresses, and arbitrary nested metadata are
not representable in a `TelemetryEvent`. `createTelemetryEvent()` does not retain its raw inputs;
only the HMAC digest can cross this boundary. The HMAC key must remain process-private and never
be put in an event, evidence artifact, or CLI argument.

The contract permits the complete funnel sequence plus bounded readiness, alert, and
reconciliation events. A logical event needs its durable idempotency key before an engine adapter
emits it; the contract does not create storage rows or decide duplicate delivery.

## Integration Boundary

This task deliberately contains no engine instrumentation. A later engine-owned change must:

1. Construct the event at trusted request/job boundaries with a process-private HMAC key.
2. Persist or publish one event per durable logical event, using the existing idempotency boundary.
3. Send only the resulting `TelemetryEvent` to logs and local OTLP, never the raw input object.
4. Exercise privacy-sentinel fire/recover probes against the real collector and retained evidence.

`scripts/reconcile-beta.ts` remains read-only. It accepts a sanitized count fixture from an
injected adapter, groups only `{ source, reason_code, count }`, and creates a deterministic plan
hash. It has no apply mode; `--apply` is rejected. A database-owned follow-up may implement an
explicit mutation workflow separately, after validating this dry-run digest and the release gates.
