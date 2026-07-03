# Track Reference: Prediction Markets And Settlement

Last researched: 2026-06-30.

Listing: https://superteam.fun/earn/listing/prediction-markets-and-settlement/

## Track Snapshot

- Sponsor: TxODDS
- Status as of 2026-06-30: open
- Region: global
- Track pool: 18,000 USDT
- Rewards: 12,000 USDT for 1st, 4,000 USDT for 2nd, 2,000 USDT for 3rd
- Submission deadline: 2026-07-19 23:59:59 UTC
- Winner announcement target: 2026-07-29 15:00 UTC
- Skills tagged by Superteam: Frontend, Backend, Blockchain, Mobile, Design/UI/UX, Data Analytics
- Submission count in page payload at research time: 11

## What The Track Is About

This is the most settlement-heavy and Web3-native track. TxLINE streams real-time World Cup scores, match events, and odds, with cryptographic signatures anchored on Solana. Builders are invited to use those data streams for prediction platforms, sportsbook-style interfaces, oracle tooling, data dashboards, or on-chain settlement systems.

The listing explicitly allows several backend directions:

- Data-driven Web3 platforms that use TxLINE's high-speed SSE stream to drive frontend updates and trigger prediction resolutions.
- Optional verification layers using TxLINE cryptographic Merkle proofs, including score validation primitives.
- Custom on-chain settlement logic, including smart contracts that use CPIs into TxLINE's `validate_stat` instruction to confirm match outcomes and automate releases.
- Permissionless results validation for peer-to-peer wagering pools, smart contract escrows, and decentralized AMMs, using coins other than TxLINE.

Important architectural constraint:

- The internal TxLINE credit token is locked to the TxLINE program for data authorization. It cannot be used by contestants or end users for peer-to-peer staking, wagering pools, or wallet transfers.

## What We Need To Do To Participate

Minimum participation package:

- Build a deployed mainnet or devnet product using TxLINE feeds as a primary data source.
- Provide a live and working MVP link that judges can access.
- Provide a public repository link.
- Provide a demo video up to 5 minutes, viewable publicly. This is an absolute initial-screening requirement.
- Provide brief technical documentation explaining the core idea, business/technical highlights, and the specific TxLINE endpoints used.
- Provide written feedback on TxLINE API experience: what worked and where friction occurred.
- Submit a working build, not a pitch deck, wireframe, mockup, or concept.

For this track, the build should ideally demonstrate one or more of:

- Live or replayed TxLINE data ingestion.
- Deterministic market resolution.
- Clear audit trail from match data to outcome.
- On-chain or verifiable settlement.
- A usable frontend or API that shows judges how resolution works.

## Suggested Project Shapes From The Brief

- Full-tournament auto-market: creates, displays, and resolves standard winner, total goals, or first-scorer predictions across the 104-match tournament schedule.
- Verifiable resolution UI: displays a data receipt or Merkle proof from TxLINE's feed so users can trace outcome resolution.
- Prediction market viewer: dashboard for active volumes, liquidity changes, odds shifts, and implied probabilities.
- Decentralized prediction market or AMM: holds funds such as USDC in escrow and uses a user/keeper flow to invoke validation and route funds to winners.
- Parametric sports insurance or prop bets: locks collateral in a neutral PDA and releases payouts when a verified TxLINE proof is submitted.

## Judging Criteria

The listing names three criteria:

- Core functionality: the app should smoothly ingest and operate using live or simulated TxLINE data feeds.
- User experience and use case: the platform should be intuitive and cover a compelling scenario for soccer fans or analytical users.
- Code quality and logic: resolution and validation code should be clean, documented, deterministic, and understandable.

Practical interpretation:

- Judges will reward a clean end-to-end settlement loop more than a broad but vague concept.
- A smaller market that resolves correctly and proves why it resolved is stronger than many half-working markets.
- The demo must show the full path: data arrives, state changes, proof/receipt is available, settlement happens or can be simulated safely.

## TxLINE Implementation Surface

Use the matching network throughout. Do not mix a devnet subscription with mainnet activation or endpoints.

Useful endpoints:

- Fixtures: `GET /api/fixtures/snapshot`
- Latest odds for a fixture: `GET /api/odds/snapshot/{fixtureId}`
- Live odds for a fixture: `GET /api/odds/updates/{fixtureId}`
- Historical odds interval: `GET /api/odds/updates/{epochDay}/{hourOfDay}/{interval}`
- Odds SSE stream: `GET /api/odds/stream`
- Odds Merkle proof: `GET /api/odds/validation`
- Score snapshot: `GET /api/scores/snapshot/{fixtureId}`
- Score updates for fixture: `GET /api/scores/updates/{fixtureId}`
- Historical score interval: `GET /api/scores/updates/{epochDay}/{hourOfDay}/{interval}`
- Full historical score sequence: `GET /api/scores/historical/{fixtureId}`
- Score SSE stream: `GET /api/scores/stream`
- Score stat validation proof: `GET /api/scores/stat-validation?fixtureId=<id>&seq=<seq>&statKey=<key>`
- Optional two-stat proof: add `statKey2=<key>`

Authentication headers:

- `Authorization: Bearer <guest_jwt>`
- `X-Api-Token: <api_token>`

On-chain validation:

- TxLINE's example validates scores data against on-chain Merkle roots.
- `validateStat` supports single-stat and two-stat validation.
- Daily scores PDA seed: `daily_scores_roots` plus epoch day.
- For settlement demos, use `view()` or a devnet/test flow unless we have a reason to deploy a production escrow.

Soccer stat keys for validation and settlement:

- Full-game stat keys: 1 participant 1 goals, 2 participant 2 goals, 3 participant 1 yellow cards, 4 participant 2 yellow cards, 5 participant 1 red cards, 6 participant 2 red cards, 7 participant 1 corners, 8 participant 2 corners.
- Period-specific stat key formula: `(period * 1000) + base_key`.
- First half adds 1000, second half adds 2000, extra time first half adds 3000, extra time second half adds 4000, penalty shootout adds 5000.

## Build Checklist For This Track

- Pick one network: devnet for judge-friendly testing unless mainnet is materially useful.
- Activate TxLINE access and document the exact service level used.
- Build a fixture selector using `fixtures/snapshot`.
- Ingest either streams or snapshots for scores/odds.
- Persist raw incoming updates or receipts so the demo can replay even after matches end.
- Define a small set of markets/props with deterministic resolution rules.
- If on-chain: define escrow/mint/payment asset, proof submission, validation, payout routing, and failure states.
- If off-chain UI/dashboard: display proof/receipt and deterministic resolution explanation.
- Create a demo account or public read-only mode requiring no payment and no special wallet setup.
- Include a "TxLINE endpoints used" section in docs.
- Record a 5-minute-or-less video showing market creation, update, resolution, and proof/auditability.

## Risks To Avoid

- Do not use TxLINE credit tokens for user wagering, staking, or peer-to-peer transfers.
- Do not require judges to buy tokens, connect funded wallets, pay fees, or register for third-party services to evaluate the project.
- Do not build illegal gambling or wagering activity for restricted jurisdictions.
- Do not imply FIFA or tournament-organizer endorsement.
- Do not submit a legacy prediction project with TxLINE bolted on. The safest strategy is a new build made for this hackathon.

## Sources

- Track listing: https://superteam.fun/earn/listing/prediction-markets-and-settlement/
- Hackathon overview: https://superteam.fun/earn/hackathon/world-cup
- TxLINE World Cup free tier: https://txline.txodds.com/documentation/worldcup
- TxLINE streaming data: https://txline.txodds.com/documentation/examples/streaming-data
- TxLINE on-chain validation: https://txline.txodds.com/documentation/examples/onchain-validation
- TxLINE soccer feed: https://txline.txodds.com/documentation/scores/soccer-feed
- TxLINE program addresses: https://txline.txodds.com/documentation/programs/addresses
- TxLINE OpenAPI YAML: https://txline.txodds.com/docs/docs.yaml
- TxODDS hackathon terms: https://txline.txodds.com/documentation/legal/hackathon-terms

