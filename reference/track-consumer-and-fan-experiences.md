# Track Reference: Consumer And Fan Experiences

Last researched: 2026-06-30.

Listing: https://superteam.fun/earn/listing/consumer-and-fan-experiences/

## Track Snapshot

- Sponsor: TxODDS
- Status as of 2026-06-30: open
- Region: global
- Track pool: 16,000 USDT
- Rewards: 10,000 USDT for 1st, 4,000 USDT for 2nd, 2,000 USDT for 3rd
- Submission deadline: 2026-07-19 23:59:59 UTC
- Winner announcement target: 2026-07-29 15:00 UTC
- Skills tagged by Superteam: Frontend, Backend, Blockchain, Mobile, Design/UI/UX, Data Analytics
- Submission count in page payload at research time: 3

## What The Track Is About

This is the fan-facing product track. The brief starts from the observation that most World Cup viewers watch with a phone in hand. TxLINE gives builders live scores, real-time odds, and match events for all 104 games. The goal is to turn those feeds into products that mainstream fans would actually open during matches.

The emphasis is not on building another sports feed. It is on original consumer interactions, games, bots, social loops, and match companion experiences that update instantly as the match changes.

## What We Need To Do To Participate

Minimum participation package:

- Build a live product that works during a match, on mainnet or devnet.
- Use TxLINE data as a live input.
- Sign up through Solana / activate TxLINE access.
- Make the product functional, not a mockup.
- Provide a live and working MVP link that judges can access.
- Provide a public repository link.
- Provide a demo video up to 5 minutes, viewable publicly. This is an absolute initial-screening requirement.
- Provide brief technical documentation explaining the core idea, business/technical highlights, and exact TxLINE endpoints used.
- Provide written feedback on TxLINE API experience.

The listing says clarity of use case and quality of execution matter more than scope. This is good for us: a narrow, polished match companion can beat a sprawling unfinished app.

## Suggested Project Shapes From The Brief

- Group sweepstake: friends are assigned World Cup teams and a leaderboard updates from TxLINE data instead of a manually edited spreadsheet.
- AI pundit bot: Telegram bot posts when a meaningful event happens, such as a goal, red card, or odds shift, and explains what happened and how the market changed. Text-to-speech gets bonus points.
- Hi-Lo stats game: users guess whether the next match stat, such as shots, corners, or possession, will be higher or lower than the last update; they build streaks and share scores across all 104 games.

## Judging Criteria

The listing names five criteria:

- Fan accessibility and UX: engaging, intuitive, polished enough for a mainstream, non-technical sports fan.
- Real-time responsiveness: dynamically responds to what is unfolding on the pitch.
- Originality and value creation: creates a new fan interaction model instead of repackaging existing sports feeds.
- Commercial and monetization path: has a clear product utility or viable business path.
- Completeness and execution: feels like a functional, complete end-to-end product feature, even if the scope is deliberately small.

Practical interpretation:

- This track is probably won through taste, speed, and clarity.
- A mobile-first interface matters.
- "Live update" should be visible and emotionally meaningful, not just a timestamp changing.
- The product needs a loop: invite friends, react to events, share a result, return for the next match.

## TxLINE Implementation Surface

Most useful endpoints:

- Fixtures and schedule: `GET /api/fixtures/snapshot`
- Score snapshot: `GET /api/scores/snapshot/{fixtureId}`
- Current score updates: `GET /api/scores/updates/{fixtureId}`
- Real-time score stream: `GET /api/scores/stream`
- Latest odds: `GET /api/odds/snapshot/{fixtureId}`
- Live odds updates: `GET /api/odds/updates/{fixtureId}`
- Real-time odds stream: `GET /api/odds/stream`
- Historical score sequence for replay/demo: `GET /api/scores/historical/{fixtureId}`

Authentication headers:

- `Authorization: Bearer <guest_jwt>`
- `X-Api-Token: <api_token>`

Useful soccer encodings:

- Game phase IDs include not started, first half, halftime, second half, finished, extra time phases, penalty shootout, interrupted, abandoned, cancelled, coverage cancelled/suspended, and postponed.
- Full-game stat keys include goals, yellow cards, red cards, and corners for each participant.
- Period-specific stat keys use `(period * 1000) + base_key`.

## Build Checklist For This Track

- Pick one clear fan job: compete with friends, receive smart commentary, play a tiny live game, or follow stakes.
- Design mobile-first from the first screen.
- Use fixtures to list upcoming/live matches.
- Use score/odds streams or polling to update the experience visibly.
- Add a replay/simulation mode for demo video and judging after live matches.
- Add social loop: invite code, share card, Telegram group, leaderboard, streak, or recap.
- Add a simple monetization hypothesis: premium groups, sponsor integrations, paid tournaments, affiliate-free B2B widget, creator/community tools, or data-powered subscriptions.
- Keep wallet/Solana complexity out of the mainstream fan flow unless it directly improves the experience.
- Make the app usable without special judge setup.
- Record a demo that shows the problem, the live product flow, and exactly how TxLINE powers the experience.

## What A Strong Entry Probably Looks Like

- It feels like a finished product feature, not a developer demo.
- A non-crypto soccer fan understands it within seconds.
- It updates in response to real match events, odds movement, or scores.
- It uses TxLINE in a way a normal sports API could not easily replace: speed, odds movement, verification, or tournament-wide coverage.
- It has a clear reason to exist after the hackathon.

## Risks To Avoid

- Do not build a generic scoreboard or odds table without a stronger fan interaction.
- Do not let wallet setup block the first user experience.
- Do not use FIFA branding or imply tournament affiliation.
- Do not require judges to be online during a live match to understand the product.
- Do not make the product feel like gambling if the use case is a casual fan game.

## Sources

- Track listing: https://superteam.fun/earn/listing/consumer-and-fan-experiences/
- Hackathon overview: https://superteam.fun/earn/hackathon/world-cup
- TxLINE World Cup free tier: https://txline.txodds.com/documentation/worldcup
- TxLINE fetching snapshots: https://txline.txodds.com/documentation/examples/fetching-snapshots
- TxLINE streaming data: https://txline.txodds.com/documentation/examples/streaming-data
- TxLINE soccer feed: https://txline.txodds.com/documentation/scores/soccer-feed
- TxLINE schedule: https://txline.txodds.com/documentation/scores/schedule
- TxLINE OpenAPI YAML: https://txline.txodds.com/docs/docs.yaml
- TxODDS hackathon terms: https://txline.txodds.com/documentation/legal/hackathon-terms

