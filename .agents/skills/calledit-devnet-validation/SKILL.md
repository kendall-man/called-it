---
name: calledit-devnet-validation
description: Validate Called It locally on devnet or Soft Net with secret-safe service preflight, bounded readiness checks, and one end-to-end proof. Use when testing Telegram, escrow, Solana, indexer, Supabase, Railway, or Mini App flows in this project.
---

# Called It Devnet Validation

Devnet and Soft Net are still stateful external systems. Treat every chain write as a real state transition, but do not stop to ask for transaction confirmation when the user has already authorized this validation scope.

## Preflight once

Check process liveness, ports, database schema/version, engine health/readiness, web configuration presence, RPC/indexer reachability, and the current market/session identifiers. Print only redacted status. If a required service is down, restart it once using the existing project command, then re-check. Do not loop on restarts.

Prefer an explicit evidence snapshot over repeated commands. Record timestamps and IDs, never secrets.

## Run the smallest proof

Use one fresh fixture and one happy path. Separate these boundaries:

1. fixture creation and market initialization;
2. finalized/indexed readiness;
3. Telegram/private-link or Mini App handoff;
4. user signing/submission;
5. engine persistence and chain/indexer reconciliation;
6. terminal receipt, claim, refund, or recovery.

At each boundary, assert a concrete state transition. If a boundary is not ready, report the exact blocker and stop that branch rather than repeatedly polling.

For Surfpool escrow, prefer three local test keypairs matching a fresh on-chain oracle set with threshold 2-of-3. Remote HTTPS signer services are a public-deployment control, not a prerequisite for local validation. A complete winning-path proof requires freeze quorum, finalized settlement, a successful winner claim/payout, and the final receipt; placement and activation alone are partial evidence.

## Polling rule

Use bounded polling with a deadline, exponential backoff, and a terminal diagnostic. Never issue open-ended `wait` loops. A timeout is evidence: preserve the last state, logs, and transaction/session ID for diagnosis.

## Configuration rule

Compare required variable names and presence across engine, web, database, and signer services. Do not dump environment files or use live production values to paper over a local configuration gap. If a local web app cannot boot because web-only credentials are absent, classify that as a configuration blocker and fix the source of truth or use a documented safe fixture.

## Completion

End with a compact evidence table: boundary, expected state, observed state, timestamp/ID, and pass/fail. Clean up only resources created by this run.
