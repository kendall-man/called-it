# Called It Session Retro

Use this when asking what Codex did recently or where time was lost.

## Discovery

From the repository root, search Codex sessions by project cwd and time window. Include child sessions when measuring delegation:

```bash
python3 .agents/skills/coding-agent-sessions/scripts/find-agent-sessions.py \
  list --platform codex --from 24h --cwd tg-bot-idea \
  --include-subagents --limit 500 --workers 32
```

Read the parent sessions and raw rollout files for exact evidence. Do not infer waste from previews alone.

## Measurements

Capture:

- number of parent and child sessions;
- repeated first/last prompts;
- tool calls and wait/poll loops;
- session duration and token clues;
- duplicate audits of the same surface;
- time spent fixing environment or worktree setup;
- changes made without targeted verification.
- stale `.omo/boulder.json` worktree/session pointers and repeated wave/final-review loops;

## Classification

Classify each event as product work, necessary setup, duplicated investigation, open-ended waiting, coordination overhead, or verification debt. Count repeated prompts and root causes, not just raw tool calls.

## Output

Return three sections:

1. measured waste with session IDs and evidence;
2. the workflow rule that would have prevented it;
3. the reusable skill or script that enforces that rule.

Do not include secrets, raw environment contents, private keys, or giant transcript excerpts. Keep the retro under one page unless a full audit was explicitly requested.
