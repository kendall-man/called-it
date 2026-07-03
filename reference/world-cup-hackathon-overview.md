# World Cup Hackathon Overview

Last researched: 2026-06-30.

Primary hackathon URL: https://superteam.fun/earn/hackathon/world-cup

## Snapshot

- Name: World Cup Hackathon
- Host/platform: Superteam Earn
- Sponsor: TxODDS / TxLINE
- Sponsor entity shown on Superteam: TXODDS (UK) Limited
- Sponsor bio: Sports trading data engineered for speed, built on trust, driven by data.
- Status as of 2026-06-30: submissions open
- Prize pool: 50,000 USD/USDT across three tracks
- Core premise: build real products using TxODDS' TxLINE live football data API on Solana, including scores, match events, odds, and cryptographic verification primitives.
- Main page summary: real-time match data wired into markets, trading agents, prediction markets, and fan experiences.

## Timeline

All official dates below are from the Superteam page/listing payloads and are primary in UTC.

- Submissions opened: 2026-06-24 15:00 UTC
- Submission deadline: 2026-07-19 23:59:59 UTC
- Winner announcement: 2026-07-29 15:00 UTC
- Hackathon display date range: 24 June - 19 July
- Free hackathon data access: TxODDS says commercial data fees are waived and premium World Cup match feeds are accessible at zero cost through 2026-07-19 23:59 UTC.

Useful local conversions:

- Deadline in India time: 2026-07-20 05:29:59 IST
- Deadline in US Eastern time: 2026-07-19 19:59:59 EDT
- Deadline in US Pacific time: 2026-07-19 16:59:59 PDT

## Tracks

| Track | Prize pool | 1st | 2nd | 3rd | Listing |
| --- | ---: | ---: | ---: | ---: | --- |
| Prediction Markets and Settlement | 18,000 USDT | 12,000 | 4,000 | 2,000 | https://superteam.fun/earn/listing/prediction-markets-and-settlement/ |
| Trading Tools and Agents | 16,000 USDT | 10,000 | 4,000 | 2,000 | https://superteam.fun/earn/listing/trading-tools-and-agents/ |
| Consumer and Fan Experiences | 16,000 USDT | 10,000 | 4,000 | 2,000 | https://superteam.fun/earn/listing/consumer-and-fan-experiences/ |

Submission counts in the Superteam page payload as of research time:

- Prediction Markets and Settlement: 11
- Trading Tools and Agents: 5
- Consumer and Fan Experiences: 3

Counts can change and should be rechecked before choosing a track.

## What Every Submission Needs

The hackathon page itself asks for:

- Link to a live and working MVP that is publicly accessible.
- Link to a live demo video, such as YouTube or Loom, viewable by anyone with the link.
- Link to a public repository.
- Optional project X profile or X post.

The individual track listings add more exact form fields:

- Project title.
- Brief explanation of the project.
- Live and working MVP link.
- Demo video link, up to 5 minutes, and required to pass initial screening.
- Public repository link, such as GitHub or GitLab.
- Optional technical documentation link.
- Optional project X profile or tweet.
- Required written feedback on the team's experience using TxLINE: what worked well and where the team hit friction.

The track descriptions also require brief technical documentation that explains:

- Core idea.
- Business and technical highlights.
- Specific TxLINE endpoints used.

## Eligibility And Team Rules

Common track language:

- Open to individuals, teams with a maximum of 3 members, and AI agents, but the submission must still be owned by a real person/team/entity eligible to receive prizes through Superteam Earn.
- Functional products are required. Pitch decks, wireframes, mockups, and non-working concepts are automatically disqualified.
- A demo video is especially important because judging may happen after live match activity has ended.

Legal terms add stricter requirements:

- Participants must be 18 or older.
- Participants must be legally able to participate in their jurisdiction.
- Employees, contractors, directors, officers of TxODDS and related entities, plus immediate family/household members, are excluded.
- Teams may have no more than 3 participants.
- Each team must designate a leader as the primary contact.
- Participants must provide accurate registration information through Superteam Earn.

## Source Conflicts To Resolve Before Submission

These are not guesses; they are real conflicts between public materials. The FAQ-answer details below come from a public Reddit repost of the Superteam announcement, while the stricter rules come from the TxODDS hackathon terms. Treat the legal terms as controlling until TxODDS/Superteam confirms otherwise.

- Companies vs natural persons: the public FAQ repost says individuals, teams, and companies can participate. The TxODDS legal terms say the hackathon is open only to natural persons, and non-human entities cannot register or submit.
- Multiple prizes: the public FAQ repost says a team can win in multiple tracks if it submits distinct projects. The TxODDS legal terms say participants can enter multiple tracks but cannot win more than one prize in total.
- Previous/legacy projects: the public FAQ repost says previous projects are not allowed and submissions must be built specifically for the hackathon. The TxODDS legal terms allow public pre-existing code/components with attribution, but say significant portions of the project must be developed during the hackathon.
- Track card blurbs: one public repost appears to swap the Consumer and Trading track summaries. The individual Superteam listing pages clearly define Trading Tools and Agents as the autonomous agent/tool track, and Consumer and Fan Experiences as the fan-facing product track.

Practical stance: build a new, hackathon-specific project; keep the entrant as a real human/team; do not rely on winning multiple prizes; ask TxODDS in Telegram/Discord before submitting to more than one track.

## Judging And Winner Process

All three track pages describe the same process:

- After submissions close on 2026-07-19 at 23:59 UTC, judges review entries and compile a shortlist.
- Final track winners are evaluated against track criteria and announced after live interview rounds.
- Stablecoin prizes and post-hackathon engineering/ecosystem support are provisioned after winner interviews.

Judges will rely heavily on the demo video because live match activity may not be present during review.

## TxLINE Access Plan

TxLINE is the required data layer. It provides sports data through a hybrid Solana on-chain and TxODDS off-chain system.

Free World Cup access:

- Service level 1: World Cup and International Friendlies, 60-second delay, free.
- Service level 12: World Cup and International Friendlies, real-time, free on mainnet.
- Devnet docs currently document service level 1; check the on-chain pricing matrix before assuming devnet service level 12.
- No payment or credit card is required for the free World Cup tiers, but a Solana subscription transaction and API token activation are still required.

Authentication and activation:

- `POST /auth/guest/start` creates a guest JWT.
- Subscribe on-chain using the TxLINE program and selected free tier.
- `POST /api/token/activate` activates the subscription and returns an API token.
- Data API calls use both headers: `Authorization: Bearer <guest_jwt>` and `X-Api-Token: <api_token>`.
- Use one network consistently: RPC URL, program ID, TxL mint, guest JWT, and activation endpoint must match.

Base URLs and program IDs:

| Network | API base | Program ID | TxL token mint |
| --- | --- | --- | --- |
| Mainnet | `https://txline.txodds.com/api/` | `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA` | `Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL` |
| Devnet | `https://txline-dev.txodds.com/api/` | `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` | `4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG` |

Core endpoints likely relevant to every track:

- `GET /api/fixtures/snapshot`
- `GET /api/fixtures/snapshot?competitionId=<id>`
- `GET /api/odds/snapshot/{fixtureId}`
- `GET /api/odds/updates/{fixtureId}`
- `GET /api/odds/updates/{epochDay}/{hourOfDay}/{interval}`
- `GET /api/odds/stream`
- `GET /api/odds/validation`
- `GET /api/scores/snapshot/{fixtureId}`
- `GET /api/scores/updates/{fixtureId}`
- `GET /api/scores/updates/{epochDay}/{hourOfDay}/{interval}`
- `GET /api/scores/historical/{fixtureId}`
- `GET /api/scores/stream`
- `GET /api/scores/stat-validation`

## Compliance And Legal Notes

- Participants are responsible for complying with all applicable gambling, gaming, financial, consumer-protection, securities, privacy, and other laws.
- TxLINE and Superteam Earn do not endorse or authorize illegal betting, wagering, or financial activity.
- Projects must not imply sponsorship, endorsement, or affiliation with FIFA or tournament organizers.
- TxODDS data is licensed only for hackathon participation. Do not redistribute, publish, sublicense, sell, share, or otherwise make available the data.
- Do not attempt to extract, reconstruct, replicate, or create competing products from TxODDS data, APIs, methods, or systems.
- Submissions must be accessible to judges without requiring TxODDS to incur fees, buy software/subscriptions/tokens/crypto/assets, or set up third-party blockchain wallets/accounts.
- Participants retain ownership of their project IP, but grant TxODDS and partners a broad license to use, reproduce, display, test, and promote submissions for hackathon-related purposes.
- Prize payments may be subject to identity, eligibility, and compliance checks.

## Contact And Resources

- Superteam hackathon: https://superteam.fun/earn/hackathon/world-cup
- TxLINE quickstart: https://txline.txodds.com/documentation/quickstart
- TxLINE World Cup free tier: https://txline.txodds.com/documentation/worldcup
- TxLINE docs index: https://txline-docs.txodds.com/llms.txt
- OpenAPI YAML: https://txline.txodds.com/docs/docs.yaml
- Program addresses: https://txline.txodds.com/documentation/programs/addresses
- World Cup schedule docs: https://txline.txodds.com/documentation/scores/schedule
- Soccer feed docs: https://txline.txodds.com/documentation/scores/soccer-feed
- Streaming examples: https://txline.txodds.com/documentation/examples/streaming-data
- On-chain validation examples: https://txline.txodds.com/documentation/examples/onchain-validation
- Hackathon terms: https://txline.txodds.com/documentation/legal/hackathon-terms
- Public repost with FAQ answers: https://www.reddit.com/r/solana/comments/1ueicvd/world_cup_hackathon_powered_by_txodds_50000_in/
- Developer Discord: https://discord.gg/txodds
- Developer Telegram: https://t.me/TxLINEChat
- Sponsor X: https://x.com/txoddsofficial
