# Task 8 corrective note: wallet races and orphan deposit path

Date: 2026-07-11
Worktree: `/Users/sublime/Seb/tg-bot-idea/.claude/worktrees/direct-onboarding`
Commit target: `fix(db): harden wallet identity races`

## Review issue mapping

1. Preliminary blocker: `wager_verify_wallet_link` leaked `23505 wager_wallet_link_history_pubkey_key` under concurrent cross-user verification of one pubkey.
   - Fix: `packages/db/migrations/0005_wallet_identity.sql`
   - Change: added deterministic advisory lock order (`wallet:user` -> `wallet:pubkey` -> current-link row lock) plus unique-violation translation to typed `pubkey_reserved`.
   - Coverage: `scripts/sql-harness.wallet-identity-races.test.ts`

2. Preliminary blocker: `wager_create_pending_stake_intent` leaked `23505 ...intent_key_hash_key` under concurrent cross-user same-key collisions.
   - Fix: `packages/db/migrations/0005_wallet_identity.sql`
   - Change: added deterministic advisory lock order (`intent:user` -> `intent:key`) plus unique-violation translation to typed `field_mismatch` or original-row reuse when fields match.
   - Coverage: `scripts/sql-harness.wallet-identity-races.test.ts`

3. Preliminary blocker: `link_history_id NOT NULL` broke starter-grant SQL harness fixture seeding.
   - Fix: `scripts/sql-harness/starter-grant-support.ts`
   - Change: added `seedLinkedWallet()` to insert append-only link history first, then the current wallet link.
   - Coverage: `scripts/sql-harness.starter-grant.test.ts`

4. Final-review blocker: `apps/engine/src/wager/deposits.ts` still exported legacy orphan auto-credit behavior and tests treated it as correct.
   - Fix: `apps/engine/src/wager/deposits.ts`
   - Change: removed the auto-credit helper and replaced it with read-only `classifyOrphanDepositsForOps()`, which returns counts and a stable ops reason without crediting, attributing, or notifying.
   - Coverage: `apps/engine/src/wager/deposits.test.ts`

## Verification

All commands were run from the direct-onboarding worktree against a local disposable PostgreSQL review instance. No secret value or database URL is recorded here.

- `npx -y pnpm@10.33.0 --filter @calledit/db test`
  - PASS: 5 files, 43 tests
- `npx -y pnpm@10.33.0 --filter @calledit/db typecheck`
  - PASS
- `npx -y pnpm@10.33.0 --filter @calledit/db build`
  - PASS
- `DATABASE_URL=[redacted-local-review-db] node --test --import tsx scripts/sql-harness.wallet-identity.test.ts`
  - PASS: 3 tests
- `DATABASE_URL=[redacted-local-review-db] node --test --import tsx scripts/sql-harness.wallet-identity-races.test.ts`
  - PASS: 2 tests
- `DATABASE_URL=[redacted-local-review-db] node --test --import tsx scripts/sql-harness.starter-grant.test.ts`
  - PASS: 6 tests
- `DATABASE_URL=[redacted-local-review-db] POSTGRES_URL=[redacted-local-review-db] npx -y pnpm@10.33.0 run test:sql`
  - PASS: 18 tests, SQL harness cleanup confirmed
- `npx -y pnpm@10.33.0 --filter @calledit/engine test -- src/wager/deposits.test.ts`
  - PASS: focused deposit contract regression
- `npx -y pnpm@10.33.0 --filter @calledit/engine test -- src/api/server.test.ts src/wager/module.test.ts src/wager/deposits.test.ts`
  - PASS: 40 files, 320/320 tests in the package run
- `npx -y pnpm@10.33.0 typecheck`
  - PASS
- `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME=calledit_test_bot NEXT_PUBLIC_TELEGRAM_STARTGROUP=calledit_v1 npx -y pnpm@10.33.0 exec turbo run build --force`
  - PASS
- `git diff --check`
  - PASS
- `npx -y pnpm@10.33.0 exec tsx /Users/sublime/Seb/tg-bot-idea/.agents/skills/programming/scripts/typescript/check-no-excuse-rules.ts ...`
  - PASS: no violations in the touched TypeScript files

## Manual probes

### Typed race probe

Observed typed outcomes from a manual concurrent probe with widened insert windows:

```json
{
  "walletRace": [
    { "ok": false, "code": "pubkey_reserved" },
    { "ok": true, "link_id": 1, "relinked": false }
  ],
  "intentRace": [
    { "ok": false, "code": "field_mismatch" },
    { "ok": true, "state": "pending", "intent_id": "[generated-uuid]" }
  ]
}
```

### Manual no-credit proof

Observed read-only orphan classification with no ledger credit and no attribution:

```json
{
  "summary": {
    "orphanCount": 2,
    "totalLamports": "5999999",
    "creditableCount": 1,
    "dustCount": 1,
    "reason": "ops_reconciliation_required"
  },
  "ledgerCount": 0,
  "old1": {
    "user_id": null,
    "credited_at": null
  },
  "dust": {
    "user_id": null,
    "credited_at": null
  }
}
```

## Adversarial coverage

- Concurrency: cross-user same-pubkey verification and same-hash intent creation now return typed results, never raw unique violations.
- Privilege: wallet/intent RPC execute remains service-role-only via SQL harness privilege assertions.
- Malformed input: existing challenge invalid/expired and field mismatch cases remain covered in the wallet SQL harness.
- Dirty worktree: unrelated Task 2/Task 6 files and unrelated `.omo` content were left untouched.
- Misleading success: full SQL harness rerun was repeated after cleaning real PostgreSQL roles so the integration cleanup test exercised a genuinely clean role state.

## Cleanup

Final cleanup probe after verification:

```json
{
  "roleCount": 0,
  "disposableDbCount": 0
}
```
