# Track Reference: Trading Tools And Agents

Last researched: 2026-06-30.

Listing: https://superteam.fun/earn/listing/trading-tools-and-agents/

## Track Snapshot

- Sponsor: TxODDS
- Status as of 2026-06-30: open
- Region: global
- Track pool: 16,000 USDT
- Rewards: 10,000 USDT for 1st, 4,000 USDT for 2nd, 2,000 USDT for 3rd
- Submission deadline: 2026-07-19 23:59:59 UTC
- Winner announcement target: 2026-07-29 15:00 UTC
- Skills tagged by Superteam: Frontend, Backend, Blockchain, Mobile, Design/UI/UX, Data Analytics
- Submission count in page payload at research time: 5

## What The Track Is About

This track is for autonomous systems that use TxLINE's live odds and scores for all 104 World Cup matches. The prompt is less about consumer UX and more about tools, agents, and algorithms that act on fast, granular sports data.

The listing asks what agents look like when the underlying data is granular and fast. A strong submission should ingest TxLINE feeds, apply a defined strategy, and execute or recommend actions without manual intervention once deployed.

## What We Need To Do To Participate

Minimum participation package:

- Build a running agent or automated tool, live or on devnet.
- Ingest TxLINE feeds as a live input.
- Execute a defined strategy or decision loop.
- Show the system working, not just a polished UI.
- Provide a live and working MVP link, deployed website, functional API endpoint, or devnet endpoint for judges.
- Provide a public repository link.
- Provide a demo video up to 5 minutes, viewable publicly. This is an absolute initial-screening requirement.
- Provide brief technical documentation explaining the core idea, business/technical highlights, and exact TxLINE endpoints used.
- Provide written feedback on TxLINE API experience.
- Avoid pitch decks, mockups, or non-working concepts.

## Suggested Project Shapes From The Brief

- Sharp movement detector: monitors TxLINE odds every 60 seconds, flags significant odds shifts, logs signals, and tracks whether the signal predicted the outcome.
- Agent vs agent arena: two agents read the same TxLINE feed and run opposing strategies; positions settle on-chain and the better strategy wins over the tournament.
- In-play market maker: bot quotes buy/sell prices on in-play outcomes and adjusts as the match evolves based on TxLINE data.

## Judging Criteria

The listing names five criteria:

- Core functionality and data ingestion: the agent/tool should smoothly run using live or simulated TxLINE data.
- Autonomous operation: once deployed, it should execute its programmatic logic without manual human input.
- Logic and code architecture: decision logic should be clean, deterministic, documented, and strategically defensible.
- Innovation and novelty: the approach should be creative for algorithmic sports tracking, market analysis, or autonomous interaction.
- Production readiness: the system should be robust enough that a professional trading team, market operator, or B2B intermediary could realistically deploy it.

Practical interpretation:

- Judges will want to see logs, state transitions, and reasoning, not only a dashboard.
- A deterministic replay mode is valuable because live matches may not be active during judging.
- The "agent" should have a clear policy: inputs, thresholds/model, output actions, risk limits, and audit logs.

## TxLINE Implementation Surface

Most useful endpoints:

- Fixtures: `GET /api/fixtures/snapshot`
- Latest fixture odds: `GET /api/odds/snapshot/{fixtureId}`
- Current live fixture odds: `GET /api/odds/updates/{fixtureId}`
- Historical odds interval: `GET /api/odds/updates/{epochDay}/{hourOfDay}/{interval}`
- Real-time odds SSE: `GET /api/odds/stream`
- Score snapshot: `GET /api/scores/snapshot/{fixtureId}`
- Current score updates: `GET /api/scores/updates/{fixtureId}`
- Historical score interval: `GET /api/scores/updates/{epochDay}/{hourOfDay}/{interval}`
- Full historical score sequence: `GET /api/scores/historical/{fixtureId}`
- Real-time scores SSE: `GET /api/scores/stream`
- Optional validation: `GET /api/scores/stat-validation` or `GET /api/odds/validation`

Authentication headers:

- `Authorization: Bearer <guest_jwt>`
- `X-Api-Token: <api_token>`

Free tier choices:

- Service level 1: free, World Cup and International Friendlies, 60-second delay.
- Service level 12: free, World Cup and International Friendlies, real-time on mainnet.

Program IDs:

- Mainnet program ID: `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA`
- Devnet program ID: `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`

## Build Checklist For This Track

- Choose a narrow agent behavior that can be judged in 5 minutes.
- Create an ingestion worker for odds and/or score streams.
- Store every feed event the agent consumes.
- Store each decision with timestamp, input snapshot, strategy version, and output action.
- Add a replay mode using historical or recorded events so the demo works after live match windows.
- Add a web dashboard or CLI/API endpoint that shows agent status, positions/signals, recent decisions, and PnL or prediction score.
- Add hard risk limits: max exposure, no-action conditions, data freshness checks, duplicate event protection, and stale stream handling.
- Document the strategy in plain English and code comments.
- Include test fixtures or recorded TxLINE samples in the repo if licensing permits; if not, include a replay script that fetches from TxLINE with credentials.
- Record a demo showing autonomous start, live/replayed ingestion, decisions, logs, and final evaluation.

## What A Strong Entry Probably Looks Like

- The agent runs without a person clicking "trade" or "decide" for each event.
- Decisions are explainable and deterministic.
- It handles stream disconnects, missing data, and postponed/suspended matches.
- It can be evaluated safely without real-money betting.
- It makes clear whether it is a signal generator, market maker, settlement participant, or analysis agent.

## Risks To Avoid

- Do not require judges to fund a wallet, buy tokens, or pay for external infrastructure.
- Do not make illegal betting or wagering functionality available without compliance controls.
- Do not overclaim profitability. Show backtest/replay metrics honestly.
- Do not hide the strategy. The criteria explicitly value defensible logic and architecture.
- Do not submit an "AI agent" that is just a chat wrapper over a sports feed.
- Legal terms say non-human entities may not register or submit entries. A human/team can build an agent, but the entrant should be a real person/team.

## Sources

- Track listing: https://superteam.fun/earn/listing/trading-tools-and-agents/
- Hackathon overview: https://superteam.fun/earn/hackathon/world-cup
- TxLINE World Cup free tier: https://txline.txodds.com/documentation/worldcup
- TxLINE fetching snapshots: https://txline.txodds.com/documentation/examples/fetching-snapshots
- TxLINE streaming data: https://txline.txodds.com/documentation/examples/streaming-data
- TxLINE odds overview: https://txline.txodds.com/documentation/odds/overview
- TxLINE OpenAPI YAML: https://txline.txodds.com/docs/docs.yaml
- TxODDS hackathon terms: https://txline.txodds.com/documentation/legal/hackathon-terms

