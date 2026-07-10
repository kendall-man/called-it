# Task 2 Gate Review

DoneClaim: `pass`

## Fixed blocker

The Task 2 HTTP scrubber no longer accepts configured route-token values when they are carried under innocuous query or body keys.

- `apps/engine/src/api/server-http.ts` now compiles a typed route credential boundary once per server instance.
- The boundary rejects both credential-shaped field names and any recursively parsed query/body string value that equals a configured route token.
- Matching uses `sha256` digests with `timingSafeEqual`.
- No field is treated as a safe bypass path: if a parsed string equals a route token, the request is rejected before route handling.
- Legitimate proof payload strings still work when their values are not route tokens.

## AdversarialVerify

- Added focused regression coverage in [server-auth-credential-values.test.ts](</Users/sublime/Seb/tg-bot-idea/.claude/worktrees/direct-onboarding/apps/engine/src/api/server-auth-credential-values.test.ts>) for:
  - public, protected, and unknown routes
  - query transport, GET-with-body transport, and POST body transport
  - URL-encoded token values
  - duplicate query values
  - nested arrays and objects
  - non-token `signature` / `signedMessage` / `wallet` proof fields
  - malformed JSON staying a safe `400`

- Engine verification passed:
  - `npx -y pnpm@10.33.0 --dir apps/engine test`
  - `npx -y pnpm@10.33.0 --dir apps/engine typecheck`
  - `npx -y pnpm@10.33.0 --dir apps/engine build`

- Live bounded probe passed in [task-2-called-it-direct-onboarding-remediation-live-auth-probe-closed.txt](</Users/sublime/Seb/tg-bot-idea/.claude/worktrees/direct-onboarding/.omo/evidence/task-2-called-it-direct-onboarding-remediation-live-auth-probe-closed.txt>):
  - `200` for public routes and correct-scope auth
  - `401` for credential name/value transport in query and body
  - `403` for wrong-scope tokens
  - `404` for unknown routes when no credential transport is present
  - `400` for malformed JSON

- Hygiene checks passed:
  - `git diff --check -- apps/engine/src/api/server-http.ts apps/engine/src/api/server.ts apps/engine/src/api/server-auth-credential-values.test.ts`
  - targeted no-excuse scan found no `@ts-ignore`, `@ts-expect-error`, `as any`, `as unknown`, `enum`, or explicit `any` in the touched TS files
  - pure LOC stayed within the 250-line ceiling:
    - `server-http.ts`: 159
    - `server.ts`: 199
    - `server-auth-credential-values.test.ts`: 159

- Logs and evidence remain redacted: no configured route token string appears in the live probe artifact or captured logger output.
