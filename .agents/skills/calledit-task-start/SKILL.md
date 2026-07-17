---
name: calledit-task-start
description: Start Called It work with a bounded scope, repository-state check, and evidence-first plan. Use when beginning a new Called It task, audit, bug fix, validation run, or delegated work item in this monorepo.
---

# Called It Task Start

Run this before reading deeply or spawning agents.

## Preflight

1. Read the root `AGENTS.md` and the nearest package/app `AGENTS.md`.
2. Capture `git status --short --branch`, current branch, and the exact target path.
3. Identify whether the request is read-only, code-changing, or live validation.
4. Search for an existing recent session, branch, commit, or implementation before starting a duplicate audit.
5. Write a one-sentence success condition and a one-sentence stop condition.

Never print `.env` values, tokens, private keys, wallet seeds, or full deployment configuration. Report only presence, absence, names, and redacted error classes.

## Scope contract

State the owned files/packages, forbidden files, allowed commands, and verification level. Preserve unrelated dirty changes. Do not reset, clean, or overwrite shared worktrees.

For a delegated task, require:

- one owner and one bounded file set;
- one deliverable (finding, patch, or verification result);
- a hard time/token/tool budget;
- no follow-up spawning unless explicitly authorized;
- a handoff containing changed files, commit, checks run, and unresolved risks.

## Duplicate-work gate

Before a whole-project audit, search recent Codex sessions with the project cwd and 2-4 discriminative terms. If an equivalent audit already exists, consume its findings and inspect only changed or disputed areas. Do not repeat "audit the whole project" for orientation.

## Output

Start work only after recording: target, scope, evidence source, success condition, stop condition, and verification command(s).
