# packages/agent

## Overview

LLM touchpoints for ambient engine flow: deterministic prefilter, GLM classifier,
GLM parser with grounded tools, persona templates, deny-list guard, and golden fixtures.

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| Public exports | `src/index.ts` | Package surface |
| Model client | `src/client.ts` | Anthropic-compatible GLM transport |
| Constants | `src/constants.ts` | Model names and limits |
| Prefilter | `src/prefilter.ts` | Cheap deterministic message gate |
| Classify | `src/classify.ts` | Claim/not-claim JSON classification |
| Parse | `src/parse.ts` | Tool-grounded claim extraction |
| Persona | `src/persona.ts`, `src/templates.ts` | Copy templates and optional garnish |
| Golden set | `src/goldenSet.ts` | Slang/typo/non-claim fixtures |

## Conventions

- "LLM proposes, code disposes": outputs are candidates, never direct mutations.
- Tests should not require live GLM. Live mode is behind `AGENT_LIVE=1`.
- Persona must fall back to deterministic templates on error/timeout.
- Deny-list violations return safe template copy.

## Commands

```bash
npx -y pnpm@10.33.0 --filter @calledit/agent typecheck
npx -y pnpm@10.33.0 --filter @calledit/agent test
npx -y pnpm@10.33.0 --filter @calledit/agent build
```
