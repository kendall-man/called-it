# packages/market-engine

## Overview

Pure deterministic core: claim compilation, pricing, settlement evaluation, and the
market reducer. This package is the product's trust boundary.

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| Domain types | `src/types.ts` | Shared taxonomy and state contracts |
| Constants | `src/constants.ts` | Tunables imported by engine/wager code |
| Compile | `src/compile.ts` | LLM parse -> validated MarketSpec or reject/clarify |
| Price | `src/price.ts` | Probability and multiplier derivation |
| Evaluate | `src/evaluate.ts` | Pure settlement predicate |
| Reduce | `src/reduce.ts` | Event-driven market state machine |
| Test helpers | `src/testkit.ts` | Shared assertions and fixtures |

## Conventions

- No I/O, no `Date.now()`, no env reads, no package side effects.
- The LLM proposes `RawClaimParse`; only this package decides valid `MarketSpec`.
- Preserve period semantics: `FT` can include extra time/pens where relevant; `FT_90` is regulation.
- Own goals count for team tallies but never player claims.
- Delay-snipe, VAR freeze, coverage void, and debounce rules belong here, not in the engine.

## Commands

```bash
npx -y pnpm@10.33.0 --filter @calledit/market-engine typecheck
npx -y pnpm@10.33.0 --filter @calledit/market-engine test
npx -y pnpm@10.33.0 --filter @calledit/market-engine build
```
