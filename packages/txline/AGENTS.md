# packages/txline

## Overview

Typed TxLINE client plus live SSE and replay sources. Converts raw TxLINE records into
`@calledit/market-engine` events and odds inputs.

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| HTTP client/auth | `src/client.ts` | Guest auth, token activation, snapshots, validation |
| Schemas | `src/schemas.ts` | Zod contracts for TxLINE payloads |
| Scores normalization | `src/normalize-scores.ts` | Raw scores -> MatchEvent |
| Odds normalization | `src/normalize-odds.ts` | Odds records -> OddsInputs/suspension events |
| Live source | `src/live-source.ts` | SSE, cursor resume, heartbeat, reconnect |
| Replay source | `src/replay-source.ts` | asOf polling/diffing for demo replays |
| SSE parser | `src/sse.ts` | ReadableStream frame parser |

## Conventions

- Parse raw payloads defensively; log unknown feed shapes instead of crashing ingestion.
- Do not commit real TxLINE feed data. Tests use synthesized fixtures.
- Keep cursor names stable: engine persists Last-Event-ID by stream/fixture.
- Half-time odds suspensions must not freeze full-match markets.

## Commands

```bash
npx -y pnpm@10.33.0 --filter @calledit/txline typecheck
npx -y pnpm@10.33.0 --filter @calledit/txline test
npx -y pnpm@10.33.0 --filter @calledit/txline build
```
