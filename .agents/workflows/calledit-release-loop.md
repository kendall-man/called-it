# Called It Release Loop

Use this sequence for a cross-package fix or release-readiness task.

## 1. Start gate

- Read root and nearest-scope `AGENTS.md` files.
- Inspect branch and dirty files.
- Search recent sessions and existing commits for equivalent work.
- Define one success condition, one stop condition, and owned paths.

## 2. Evidence gate

- Build a short flow map from ingress to terminal state.
- Run one bounded audit farm only for disjoint questions.
- Deduplicate findings by root cause.
- Choose the smallest fix and one owner per contract.

## 3. Implementation gate

- Patch the smallest owned surface.
- Preserve unrelated user changes.
- Keep cross-package type/database/API contracts explicit.
- Add or update focused tests for changed pure logic and persistence boundaries.

## 4. Verification gate

- Run targeted typecheck/tests first.
- Run the relevant package build.
- Run one integration or local devnet proof when the change crosses a runtime boundary.
- Use bounded polling and record redacted evidence.

## 5. Handoff gate

Report changed files, commit, commands and outcomes, live proof IDs/states, unresolved risks, and the exact next action. Do not start another audit cycle merely because a live dependency is unavailable.

## Stop conditions

Stop when the success condition is proven, when a repeated external blocker has been isolated, or when the remaining work requires a new user decision or authority. Do not turn uncertainty into more parallel sessions.
