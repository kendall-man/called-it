---
name: calledit-audit-farm
description: Run efficient, non-duplicative Called It audits across Telegram, web, engine, database, Solana, and deployment surfaces. Use when reviewing production risk, release readiness, or a cross-package workflow in this monorepo.
---

# Called It Audit Farm

Use a small evidence farm, not a swarm.

## Default shape

Start with one lead agent that maps the flow and names concrete questions. Spawn at most four independent reviewers only when their scopes are genuinely disjoint:

1. Telegram/user flow
2. web/Mini App auth and UX
3. engine/database state and recovery
4. chain/indexer/deployment readiness

Do not spawn a second whole-project orientation agent. Do not give every reviewer the full repository history. Pass the lead's map, exact paths, and a question list.

## Reviewer contract

Each reviewer must return no more than five findings, ordered by severity, with file/line evidence, user impact, confidence, and a minimal fix. Findings that depend on live infrastructure must identify the observation and the code path separately.

Use a fixed budget: 10-15 minutes, one child session, and a bounded tool-call/token budget. If a reviewer hits missing services or credentials, record the blocker and stop; do not keep polling or rebuild the environment.

## Merge and dedupe

The lead owns synthesis. Group findings by root cause, not by reviewer. Discard duplicate wording and speculative issues without evidence. Assign one implementation owner per root cause, with disjoint file ownership.

After patches land, run one integration review against the combined diff. Do not re-run all four audits unless the architecture or trust boundary changed.

## Anti-patterns learned

- Repeated "audit the whole project" prompts create huge duplicated context and no new evidence.
- Hundreds of children make synthesis harder and can outlive the useful task.
- Parallel agents editing adjacent contracts without a shared interface review creates late wiring failures.
- A passing static review is not a substitute for the smallest executable proof of the changed boundary.
