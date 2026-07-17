---
name: calledit-recovery-checkpoint
description: Audits and preserves Called It Git branches, worktrees, reflogs, unreachable commits, stashes, and committed-state bundles without touching secrets or dirty files. Use when recovering prior agent work, checking backups, handing off worktrees, or creating a safe checkpoint before risky integration.
---

# Called It Recovery Checkpoint

Use `pnpm recovery -- report` before assuming work was lost. It reports branches, worktrees, stashes, and unreachable commits without printing file contents.

If `.omo/boulder.json` names an active worktree that no longer exists, treat the plan as stale orchestration metadata. Recover from the recorded branch/commit and retained evidence; do not recreate the vanished `/tmp` directory and continue blindly.

Create a committed-state backup with:

```bash
pnpm recovery -- bundle
```

Bundles are written under ignored `.calledit-backups/`. They include every reachable ref but never uncommitted files or ignored credentials.

Preserve a verified unreachable commit before garbage collection:

```bash
pnpm recovery -- preserve <commit> codex/recovered-<name>
```

Inspect the commit first with `git show --stat <commit>`. Never attach arbitrary blobs or trees. Do not clean prunable worktrees until their branch/ref and dirty-state status are recorded.

Remote branches are the durable backups. A local branch or bundle protects against accidental ref loss but not disk loss. Push only when the task authorizes remote backup or publication.
