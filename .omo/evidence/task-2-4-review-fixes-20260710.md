# Task 2 + Task 4 Review Fixes Evidence

Worktree: `/Users/sublime/Seb/tg-bot-idea/.claude/worktrees/direct-onboarding`
Base requested by caller: `9637d9f`
Captured: 2026-07-10

## Scope

Owned files touched:

- Engine API/runtime/env/security/tests: `apps/engine/src/api/server-auth.test.ts`, `apps/engine/src/api/server-http.ts`, `apps/engine/src/api/server-test-harness.ts`, `apps/engine/src/api/server-write.ts`, `apps/engine/src/env.ts`, `apps/engine/src/env.test.ts`, `apps/engine/src/wiring.ts`, `apps/engine/src/wiring.test.ts`, `apps/engine/src/wiring-proof.ts`, `apps/engine/src/wiring-wager.ts`
- Concierge runtime/env/tests/docs: `apps/concierge/agent/channels/telegram.ts`, `apps/concierge/agent/env.ts`, `apps/concierge/agent/env.test.ts`, `apps/concierge/agent/runtime/telegram-forwarding.ts`, `apps/concierge/agent/runtime/telegram-forwarding.test.ts`, `apps/concierge/AGENTS.md`
- Web env/tests: `apps/web/lib/env.ts`, `apps/web/lib/env.test.ts`, `apps/web/lib/token-fingerprint.ts`
- Env/docs/evidence: `.env.example`, `README.md`, `docs/operations/environment.md`, `docs/operations/rollout.md`, this file
- Removed per review request: `apps/engine/src/api/server-write.test.ts`

Explicitly not touched/staged: `package.json`, `packages/db/**`, `scripts/sql-harness*`, unrelated `.omo/**` artifacts.

## Fixes

- Quote parse failures now log only stable metadata: `api_quote_parse_failed` with `reason=parse_exception`; untrusted Error text is never stringified into logs.
- `WEB_CONCIERGE_TOKEN` uniqueness is enforced through SHA-256 fingerprints:
  - Engine accepts only `WEB_CONCIERGE_TOKEN_SHA256` for cross-scope audit and strips it from runtime config.
  - Concierge accepts only `ENGINE_OPS_TOKEN_SHA256` for the ops-token audit and strips it from runtime config.
  - Web accepts only `ENGINE_*_TOKEN_SHA256` fingerprints for route-token audit and strips them from runtime config.
- `wiring.ts` dependency catches now narrow to `Error` and rethrow unknown thrown values. Task4 runtime audit also tightened `wiring-proof.ts` and `wiring-wager.ts` from `error.toString()` to `error.message` after narrowing.
- Concierge Telegram forwarding no longer catches and logs engine forwarding failures. Message, command, and callback forwarding failures reject so webhook/runtime retry semantics are preserved.
- Removed the deletion-only exact-export test for `server-write.ts`; `/api/stake` 404 behavior remains covered in `server-auth.test.ts`.
- Malformed JSON still returns safe 400, now with strict `SyntaxError` catch narrowing and no input logging.

## Red -> Green

Red run before implementation:

```text
npx -y pnpm@10.33.0 --filter @calledit/engine test -- src/api/server-auth.test.ts src/env.test.ts src/wiring.test.ts
Result: exit 1
Observed failures:
- env fingerprint reuse tests did not throw.
- quote parser redaction test logged untrusted exception text containing Authorization.
- wiring helper test failed because unknown-throw narrowing was absent.
```

Green focused runs after implementation:

```text
npx -y pnpm@10.33.0 --filter @calledit/engine test -- src/api/server-auth.test.ts src/env.test.ts src/wiring.test.ts
Result: 36 files, 309 tests passed.

npx -y pnpm@10.33.0 --filter callie test -- agent/env.test.ts agent/runtime/telegram-forwarding.test.ts
Result: 10 files, 59 tests passed.

npx -y pnpm@10.33.0 --filter @calledit/web test -- lib/env.test.ts
Result: 6 files, 55 tests passed.
```

## Verification

Focused/full automated verification:

```text
npx -y pnpm@10.33.0 --filter @calledit/engine test
Result: 36 files, 309 tests passed.

npx -y pnpm@10.33.0 --filter @calledit/engine typecheck
Result: PASS.

npx -y pnpm@10.33.0 --filter @calledit/engine build
Result: PASS.

npx -y pnpm@10.33.0 --filter callie test
Result: 10 files, 59 tests passed.

npx -y pnpm@10.33.0 --filter callie typecheck
Result: PASS.

npx -y pnpm@10.33.0 --filter callie eve:build
Result: PASS. Expected warning: runtime/ is not a discovery root; runtime modules are imported by channel/hook files.

npx -y pnpm@10.33.0 --filter @calledit/web test
Result: 6 files, 55 tests passed.

npx -y pnpm@10.33.0 --filter @calledit/web typecheck
Result: PASS.

NEXT_PUBLIC_TELEGRAM_BOT_USERNAME=calledit_test_bot NEXT_PUBLIC_TELEGRAM_STARTGROUP=calledit_v1 STARTER_GRANTS_ENABLED=false WALLET_MINIAPP_ENABLED=false STAKE_ACCEPTANCE_ENABLED=false npx -y pnpm@10.33.0 --filter @calledit/web build
Result: PASS. Routes generated: /, /_not-found, /g/[slug], /r/[marketId].

npx -y pnpm@10.33.0 verify:product-copy
Result: PASS, product copy contract passed 45 files.

git diff --check
Result: PASS.
```

The first web build without env failed as expected at the invoked build-time env parser:

```text
npx -y pnpm@10.33.0 --filter @calledit/web build
Result: exit 1, Web environment invalid: NEXT_PUBLIC_TELEGRAM_BOT_USERNAME, NEXT_PUBLIC_TELEGRAM_STARTGROUP.
```

## Manual QA

Invocation:

```text
npx -y pnpm@10.33.0 exec tsx -
```

Binary observable from the live engine HTTP process and concierge retry helper:

```text
live_200: status=200 body={"status":"live"}
missing_credential_401: status=401 body={"error":"unauthorized"}
wrong_scope_403: status=403 body={"error":"forbidden"}
stake_removed_404: status=404 body={"error":"not_found"}
quote_parse_502: status=502 body={"error":"parse_unavailable"}
quote_redaction: has_reason=true leaked=false
telegram_ingress_500: status=500 body={"error":"internal","requestId":"<uuid>"}
ingress_redaction: has_reason=true leaked=false
retry_group_message: propagated=true
retry_private_command: propagated=true
retry_callback: propagated=true
```

The redaction sentinels were fake values generated inside the QA script and were not written to this evidence file.

## LOC And No-Excuse Audit

Exact Task4 production set:

```text
Source: git show --name-only --format='' 75b7a5d, excluding .omo evidence.
Count: 31 files.
Max pure LOC: 248, apps/engine/src/wiring.ts.
No-excuse pattern scan: 0 matches for as any, as unknown, ts-ignore, ts-expect-error, empty catch, console.log, console.error, String(error), error.toString().
```

Current Task2 set:

```text
Source: git show --name-only --format='' 9637d9f, excluding .omo evidence, docs/scripts/CONTRACTS, and the removed server-write exact-export test.
Count: 16 files.
Max pure LOC: 233, apps/engine/src/env.ts and apps/concierge/agent/env.test.ts.
No-excuse pattern scan: 0 matches for as any, as unknown, ts-ignore, ts-expect-error, empty catch, console.log, console.error, String(error), error.toString().
```

Changed/new file pure LOC:

```text
apps/engine/src/api/server-test-harness.ts 246
apps/engine/src/api/server-auth.test.ts 187
apps/engine/src/api/server-write.ts 93
apps/engine/src/api/server-http.ts 117
apps/engine/src/env.ts 233
apps/engine/src/env.test.ts 156
apps/engine/src/wiring.ts 248
apps/engine/src/wiring.test.ts 20
apps/engine/src/wiring-proof.ts 54
apps/engine/src/wiring-wager.ts 224
apps/concierge/agent/env.ts 220
apps/concierge/agent/env.test.ts 233
apps/concierge/agent/channels/telegram.ts 50
apps/concierge/agent/runtime/telegram-forwarding.ts 35
apps/concierge/agent/runtime/telegram-forwarding.test.ts 55
apps/web/lib/env.ts 209
apps/web/lib/env.test.ts 199
apps/web/lib/token-fingerprint.ts 81
```

## Review And Debugging Gate

Review lanes:

- Goal and constraints: PASS. Every requested finding maps to a code change, a behavior test, and runtime evidence.
- QA execution: PASS. Live HTTP server observed 200/401/403/404/502/500 and retry propagation.
- Code quality: PASS. Typechecks/builds passed; changed files are <=250 pure LOC; no no-excuse matches.
- Security: PASS. Raw cross-scope secrets are no longer required by opposite runtimes; redaction sentinels did not appear in logs.
- Context/shared-worktree: PASS. Task8-owned `package.json`, DB, and SQL harness files were not edited, staged, or reverted.

Debugging hypotheses with runtime evidence:

1. Hypothesis: quote parse failures leaked because the catch stringified `Error`.
   Evidence: red focused run logged exception text; green live QA reported `quote_redaction has_reason=true leaked=false`.
   Result: confirmed and fixed.

2. Hypothesis: Telegram forwarding failures were acknowledged because the channel caught and logged rejected forwards.
   Evidence: green runtime helper QA reported `retry_group_message`, `retry_private_command`, and `retry_callback` all `propagated=true`.
   Result: confirmed and fixed.

3. Hypothesis: deploy-time token uniqueness required raw cross-scope secrets in opposite runtimes.
   Evidence: env parser tests now pass positive/negative SHA-256 fingerprint cases; runtime configs strip audit fingerprint fields.
   Result: confirmed and fixed.

## Cleanup

- No temp source instrumentation was added.
- No package scripts were edited.
- `git diff --check` passed.
- Remaining untracked `.omo/**` baseline/review artifacts pre-existed this task and are intentionally unstaged.
- Build outputs `.next/`, `.output/`, and `dist/` are ignored and not staged.
