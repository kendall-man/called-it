# Website inspiration: BONKbot landing-page content audit

**Reference:** [bonkbot.io](https://bonkbot.io/)

**Audited:** 2026-07-19

**Purpose:** Content and information-delivery inspiration for Rumble. This is not a visual-design audit and is not a recommendation to copy BONKbot's branding, layout, motion, or claims.

## Executive summary

BONKbot's landing page does more than describe a product. It repeatedly turns information into an action, proof, or concrete example:

- The main action opens the real Telegram bot, while an adjacent fallback helps people who do not yet have Telegram.
- Token examples include the ticker, shortened contract address, a copy action, and a token-specific Telegram deep link—not just a generic “trade” button.
- Third-party discovery sources are named and linked, showing how users can move from finding a token to trading it.
- Product claims are followed by usage metrics, a step-by-step product walkthrough, real Telegram screenshots, advanced-feature explanations, social proof, and FAQs.
- Shareable P&L cards do two jobs: they show the result and carry a “trade now” QR code/referral path for the next user.
- Security, fees, setup, support, and referral economics are not left to documentation alone; the landing page answers them in accordions.
- The same primary action returns after major persuasion moments and again in the footer.

The most useful lesson for Rumble is: **pair every important claim with the next thing a visitor needs to understand, verify, or do.** A link may need a QR equivalent; a feature claim may need a real Telegram state; a settlement claim may need a receipt; a trust claim may need the named evidence source; and an unfamiliar term may need a plain-language FAQ.

## Scope and caveats

- This audit records the live landing page and its expanded FAQ states as observed on the audit date.
- BONKbot renders separate responsive variants and looping content in the document source. Repeated markup has been normalized into the intended page sections below.
- Usage figures and product terms are point-in-time claims, not independently verified facts.
- Several BONKbot patterns—profit-led testimonials, “fastest” claims, referral kickbacks, fees, and mainnet trading language—are not suitable for Rumble's current devnet, no-fee beta.
- Rumble's [design contract](./DESIGN.md) describes the product as a compact product surface, not a marketing site, and rejects fake/demo content and instructional feature tours. The Rumble recommendations below adapt BONKbot's information discipline without importing its page length or marketing style.

## Page-level positioning and metadata

| Information | What BONKbot says | How it is delivered |
| --- | --- | --- |
| Browser/search title | “Solana's Fastest Telegram Trading Bot \| BONKBot” | HTML title and social metadata; immediately names category, network, channel, and primary claim. |
| Search/social description | “The fastest and simplest way to trade on Solana. No compromises.” | Repeated in description, Open Graph, and X/Twitter metadata so the external preview matches the hero promise. |
| Hero promise | Fastest and simplest way to trade on Solana; “No Compromises.” | Large, short statement paired with a live-product phone view rather than a long explanatory paragraph. |
| Product category | Telegram-based Solana trading platform/bot | Reinforced in the title, product copy, screenshots, CTA destination, and FAQ. |
| Core benefit | Buy, sell, and manage a portfolio quickly inside Telegram without repeated wallet connection or transaction-confirmation steps | Stated in a concise explanatory block after the first CTA. |
| Primary CTA | Start Trading | A real deep link to `https://t.me/bonkbot_bot?start=ref_start`, repeated in navigation, content breaks, and the closing CTA. |
| Secondary product promotion | Telemetry trading terminal | A persistent announcement strip with a learn-more destination and a separate “Try Telemetry” action to the app. |

## Landing-page information architecture

The page's normalized narrative is:

1. Announce the related Telemetry terminal.
2. Give Blog, Docs, Features, and Start Trading navigation.
3. State the fastest/simplest Solana trading promise.
4. Show the product in its real environment: Telegram on a phone.
5. Provide a Start Trading action and a Telegram-install fallback.
6. Demonstrate tradable examples and ecosystem entry points.
7. Explain what the product does and remove wallet/transaction friction.
8. Establish popularity and scale with usage metrics.
9. List the technical/product capabilities behind the promise.
10. Walk through the basic workflow in four steps.
11. Explain alpha alerts and one-click action from those alerts.
12. Explain advanced order types and automation with outcome diagrams.
13. Show shareable P&L cards and the referral loop built into them.
14. Ask the user to start trading again.
15. Provide a large stream of named community testimonials.
16. Answer setup, security, fee, support, and referral questions.
17. Close with a final Start Trading CTA and legal/resource links.

## Section-by-section audit

### 1. Related-product announcement

**Information provided**

- A new trading terminal called Telemetry is live.
- Visitors can learn more at the Telemetry marketing site or try the terminal directly.

**How it is provided**

- A persistent top announcement contains both an informational destination and a direct-use destination.
- The distinction between “learn” and “try” is explicit rather than putting both intents behind one generic link.

**Reusable principle**

If Rumble ever promotes a secondary surface such as the group board, account recovery, or receipts library, label the destination by intent: “See group board,” “Open private account,” or “Verify a receipt.”

### 2. Navigation

**Information provided**

- Blog
- Documentation
- Feature anchor
- Start Trading

**How it is provided**

- Educational destinations are low-commitment links.
- The Telegram action is visually and semantically treated as the primary navigation action.
- The header remains available while scrolling, keeping both learning and conversion paths reachable.

**Reusable principle**

Keep Rumble's one dominant “Add to Telegram group” action. If support links are added, use destination-specific labels and keep them subordinate.

### 3. Hero and immediate product understanding

**Information provided**

- BONKbot claims to be the fastest and simplest way to trade on Solana.
- It rejects compromise as a positioning statement.
- The product runs inside Telegram.

**How it is provided**

- The promise is short enough to understand before scrolling.
- A phone mockup shows an actual BONKbot Telegram conversation and controls.
- Small token icons beside the claim imply the range of assets the bot can handle.
- A Start Trading button opens the real bot.
- “Don't have Telegram yet? Install here” links to Telegram, removing a prerequisite dead end.

**Nuance**

The Telegram-install link is not another product CTA. It is a recovery path for someone who cannot complete the primary action yet.

**Rumble analogue**

- Keep the direct group-add deep link and the QR code already implemented on Rumble's landing page.
- Pair the hero with one real, privacy-safe group-call or receipt state so visitors can see what “Rumble settles it” produces.
- If Telegram is unavailable or not installed, say exactly what is needed next; do not leave a disabled or unexplained CTA.

### 4. Actionable token examples and ecosystem entry points

**Information provided**

- Example assets: BONK, GIGA, and WIF.
- Each example exposes a shortened contract address.
- Visitors can copy the address or buy the specific token with BONKbot.
- Users can discover more tokens on pump.fun, DEXScreener, and Birdeye.
- Meteora is also named later as a URL source accepted by the bot.

**How it is provided**

- Each token is a compact action unit: identity, address, copy affordance, and “Buy With BONKbot.”
- “Buy With BONKbot” links are context-specific Telegram deep links containing the selected contract address. The user does not have to re-enter the token after opening Telegram.
- External discovery sources are named, linked, and framed as part of the workflow rather than as generic partner logos.
- The content loops across the page as a feed, making the supported workflow feel active.

**Reusable principle**

Preserve user intent across surface changes. A Rumble deep link from a group, receipt, or board should carry the exact safe context needed for the destination instead of sending everyone to a generic home state.

### 5. Product explanation and friction removal

**Information provided**

- BONKbot positions itself as an advantage for trading on Solana.
- Users can buy, sell, and manage a portfolio in Telegram.
- The claimed benefits are speed and execution quality.
- The stated friction removed is repeatedly connecting wallets and confirming transactions.

**How it is provided**

- The section follows the visual product proof and CTA, answering “why this instead of my current workflow?”
- The explanation uses task verbs—buy, sell, manage—rather than only technical terminology.
- It contrasts the old friction with the new path in two short paragraphs.

**Rumble analogue**

Explain the avoided friction in Rumble's own terms: a football call goes from group message to consented two-sided offer to match-data settlement and a public receipt, without moving the conversation out of Telegram.

### 6. Popularity, history, and scale proof

**Information provided**

- “The original, most popular trading bot on Solana.”
- “Built during the bear to help you conquer the bull.”
- 69.3M trades.
- $10.1B volume.
- 452K users.

**How it is provided**

- Three large counters make adoption claims scannable.
- A separate origin/history line adds longevity and identity, not just current scale.
- The metrics appear near the product explanation, functioning as evidence for popularity.

**Caution for Rumble**

Only publish metrics backed by production data and define them precisely. For the beta, honest operational proof is stronger than vanity metrics—for example, settled calls, verified receipts, feed coverage, or finalization status—provided privacy and devnet-value rules are preserved.

### 7. Capability and execution explanation

**Information provided**

- Routing is powered by Jupiter plus proprietary routing logic.
- Ultra-low latency.
- High throughput.
- MEV protection.
- Smart execution routing.
- Optimized transaction propagation.
- Advanced security and encryption.
- Token intelligence.
- Real-time alpha alerts.
- “It just works.”

**How it is provided**

- The named infrastructure partner makes the routing claim more concrete.
- A long capability stream follows the concise benefit statement, allowing experts to inspect the reasons without forcing all visitors through technical detail first.
- Capabilities are later revisited as focused features with product screenshots and explanations.

**Rumble analogue**

Lead with the user outcome, then make the proof inspectable: match data by TxLINE, deterministic compiled terms, explicit speaker consent, peer matching, unmatched-SOL refunds, Solana proof state, and a public privacy-safe receipt.

### 8. Four-step basic workflow

**Information provided**

1. Send SOL to the BONKbot wallet from Phantom or a centralized exchange.
2. Choose a token by entering a ticker, contract address, or a supported URL.
3. Buy with a preset one-click amount or enter a custom SOL amount.
4. Sell with a one-click action or specify a percentage.

**How it is provided**

- A scroll-led, numbered walkthrough pairs each step with a changing real Telegram screen inside a persistent phone frame.
- Copy explains both the fastest default and the more controlled alternative.
- Step 2 names accepted sources: pump.fun, DEXScreener, Birdeye, and Meteora.
- Examples include direct discovery links and token-specific deep links.
- A Learn More action sends visitors to full documentation after the overview.

**Reusable principle**

Show defaults and control together: “one-tap default” plus “choose amount” is more informative than merely saying the product is flexible.

**Rumble constraint**

Rumble's design contract rejects instructional feature tours. Do not reproduce the long scrolling tutorial. Compress the same clarity into one real end-to-end example or a small “What happens after you add Rumble” explanation:

1. Add Rumble to a group.
2. A speaker makes or confirms a football call.
3. Members choose a side and amount.
4. TxLINE data settles the call and Rumble publishes a receipt.

### 9. Real-time alpha alerts

**Information provided**

- BONKbot provides real-time token-alert channels.
- Filters aim to reduce noise and surface opportunities.
- A user can act on an alert with one click inside the bot.

**How it is provided**

- The feature is split into two consecutive ideas: discovery and immediate action.
- The first real Telegram screenshot shows the alert-channel feed.
- The second shows the token detail and one-click buy action reached from the alert.
- The page explains not only that alerts exist, but the loop they enable: filter → inspect → trade.

**Reusable principle**

Describe a feature as a completed loop. For Rumble: detect or explicitly invoke a call → confirm speaker intent → publish deterministic sides → settle from match data → open the receipt.

### 10. Limit orders and BONKbot-only advanced features

**Information provided**

- Limit orders can buy or sell at a chosen price while the user is away.
- Partial fills allow execution in thin markets.
- Trailing stop loss aims to lock gains as prices rise and limit losses if they fall.
- Auto-Strat launches an entire trading playbook with one click.

**How it is provided**

- The parent feature gets an outcome-led explanation: set a price and let the bot work.
- Subfeatures are placed in separate cards.
- “Only on BONKbot” labels communicate exclusivity.
- Partial fills and trailing stops are explained with annotated charts, not prose alone.
- Auto-Strat uses a branching playbook diagram with example take-profit and stop-loss actions, showing what “entire playbook” means.

**Reusable principle**

Use the most literal proof format for the concept. A diagram helps when state branches; a receipt helps when settlement is the claim; a short table helps when rules or mappings are the claim.

### 11. P&L sharing and referral loop

**Information provided**

- Users can create and share P&L cards.
- Referred signups generate lifetime fee kickbacks.
- Referrals work through either a QR code or a referral link.

**How it is provided**

- A carousel shows many real-looking share-card variants.
- Cards combine result data, reaction copy, BONKbot identity, and a clear “Trade Now” QR code.
- The QR makes a screenshot or repost actionable even when the original hyperlink is lost.
- Back/next controls make the collection explorable.
- The page states the reward outcome next to the sharing mechanism, so the visitor understands why the QR/reflink matters.

**Important nuance**

The shared artifact is also an acquisition surface. It preserves enough context and a scannable route for the next person to act.

**Rumble analogue**

- Make every public receipt useful when shared as an image or link.
- Include a short verification URL and, where appropriate, a QR code that resolves to the same public receipt.
- If a receipt offers “Add Rumble to your group,” pair the link with a QR only when the medium benefits from scanning.
- Do not add referral rewards or profit framing to the current beta.

### 12. Mid-page conversion checkpoint

**Information provided**

- “Ready to level up?”
- Start Trading.

**How it is provided**

- The CTA appears immediately after advanced features and the share/referral explanation, when the visitor has enough information to act.
- It uses the same Telegram destination as the hero action, preserving consistency.

**Reusable principle**

Repeat the primary action after a meaningful proof block, not after every paragraph. Use the same label and destination unless the context genuinely changes.

### 13. Community social proof

**Information provided**

- A large set of named X/Twitter users describes using BONKbot in everyday, mobile, high-speed trading contexts.
- Testimonials cover habit, convenience, speed, profit, token discovery, referral earnings, and cultural attachment.
- User names, handles, avatars, and original informal language are retained.
- The product's X handle, `@BONKbot_io`, is promoted near the feed.

**How it is provided**

- The section is framed as a “cult following,” positioning community intensity as product proof.
- Testimonial cards form a looping, high-volume stream rather than a small curated trio.
- Credibility comes from attribution and recognizable public handles, not anonymous quotations.
- The unpolished language signals that these are community posts rather than house copy.

**Caution for Rumble**

- Do not use unverifiable, fabricated, or profit-led testimonials.
- Never expose private Telegram messages or identities.
- Prefer permissioned, privacy-safe evidence: public receipt links, aggregate usage, named partners, or explicit public endorsements.

### 14. Frequently asked questions

The FAQ is an accordion: questions remain scannable while detailed answers stay optional. The live page covers the following information.

#### What is BONKbot?

- A Telegram-based platform for trading Solana tokens.
- Claims best-available prices, speed, convenience, and powerful infrastructure on a phone.

#### Why use BONKbot?

- Speed and transaction reliability.
- Direct pump.fun integration from launch via pasted URL.
- Jupiter plus custom routing for on-chain prices.
- A low-click interface.
- Intelligent real-time token alerts.
- Configurable MEV modes: a secure-protection mode and a speed-focused turbo mode.

#### How do I start?

- Launch the bot.
- Send SOL to the BONKbot wallet.
- Start trading.
- A separate step-by-step documentation link is offered for more detail.

#### Is it secure?

- BONKbot says it has been audited by Sec3.
- It names AES-256 encryption and a multi-layered security approach.
- It states that only the user can access their funds.

#### Has it ever been hacked?

- BONKbot states that it has never been hacked.
- It addresses a March 2024 accusation directly, attributes the incident to Solareum, and describes helping freeze stolen funds.

#### How do I trade memecoins?

- Enter a ticker, contract address, or pump.fun/DEXScreener/Birdeye URL.
- Click buy.
- Open a ticker from the Home screen to manage, buy, or sell the position.

#### What are the fees?

- 1% per trade.
- Wallet creation and account setup are free.

#### Where do I get help?

- A direct [Telegram support chat](https://t.me/BONKbotChat) is provided.
- The page claims 24/7 availability and usually very fast responses.
- It warns that admins and moderators will never privately message or call first, ask for money, or request a private key.
- It explains how official admins/moderators are identified and tells users to remain vigilant because the chat is hosted on Telegram.

#### Can referrals earn rewards?

- First month: 30% of the referred user's fee revenue.
- Second month: 20%.
- Lifetime after that: 10%.
- Elsewhere on the page, the mechanisms are described as a QR code or referral link.

**Reusable principle**

The FAQ handles decision blockers, not generic filler: category, differentiation, setup, security, incident history, core task, price, help, and incentives.

### 15. Closing CTA and footer resources

**Information provided**

- “Still here?”
- “Trade on BONKBot Now.”
- Start Trading.
- Copyright.
- Terms of Service.
- Privacy Policy.
- Press.
- Media Kit.
- Documentation.
- Library.

**How it is provided**

- The last question turns remaining attention into a direct action.
- The same Telegram deep link is used again.
- Legal, press, brand, documentation, and broader content resources remain available without competing with the primary CTA earlier in the page.

## Link, QR, copy, and deep-link inventory

| User need | Mechanism | Delivery nuance |
| --- | --- | --- |
| Start using the product | Telegram deep link | Reused consistently across header, page checkpoints, and final CTA. |
| Start without re-entering a token | Token-specific Telegram deep link | Contract address is encoded in the link. |
| Use a physical/second device | QR on shareable P&L cards | The shared image remains actionable when no clickable link survives. |
| Refer a user | Referral link and QR | Two mechanisms support clickable and camera-based contexts. |
| Copy a contract | Copy-to-clipboard control | Shortened text stays readable while the full value remains actionable. |
| Install the prerequisite app | Telegram install link | Presented as recovery for people blocked from the main CTA. |
| Find a token | Direct links to pump.fun, DEXScreener, Birdeye | External tools are tied to a stated task. |
| Learn details | Docs and “Learn more” links | Long-form education is available after the concise landing explanation. |
| Get help | Direct Telegram support link | Paired with scam-safety guidance, not just a destination. |
| Verify company/product context | Terms, Privacy, Press, Media Kit, Library | Grouped in the footer as secondary trust/resources. |

## Content patterns worth borrowing

### Pair claims with proof

| Claim type | BONKbot proof | Rumble-safe equivalent |
| --- | --- | --- |
| Product runs in Telegram | Real Telegram phone screens | A real privacy-safe group offer or ready-message state. |
| Popular product | Trades, volume, users | Verified aggregate call/receipt metrics only when meaningful and defined. |
| Fast execution | Routing explanation and task walkthrough | Deterministic event/settlement path and honest proof status. |
| Advanced feature | Annotated chart or branching diagram | Receipt anatomy, consent/state sequence, or settlement/refund rule table. |
| Community adoption | Attributed public posts | Permissioned public endorsements or real aggregate receipts; never private chat. |
| Security | Named audit, encryption, incident answer, scam warning | Named controls, privacy boundaries, network disclosure, support-safety warning. |
| Shareability | Result card plus QR/reflink | Receipt URL plus optional receipt QR and one honest next action. |

### Preserve context when sending users elsewhere

BONKbot's strongest implementation detail is the token-specific Telegram deep link. It shows that a CTA can carry the visitor's selected context into the product. Rumble should use the same principle for safe, authorized contexts:

- A group-add action should retain the versioned `startgroup` setup payload.
- A public receipt link should open that exact receipt, not the landing page.
- A private recovery link should retain only the immutable, requester-scoped pending intent defined by the product contract.
- A board link should open the intended group aggregate view without exposing private group or member data.

### Offer a default and a controlled alternative

BONKbot repeatedly explains “one click” beside “choose your amount/percentage.” For Rumble, the equivalent is already part of the product contract:

- Primary sides commit the default 0.01 SOL amount.
- “Choose amount” exposes 0.05/0.10 SOL in a requester-scoped flow.
- Landing copy can communicate this concisely without turning into a tutorial or advertising unsupported choices.

### Make support content safety content

The support FAQ does not merely link to a chat. It explains impersonation risks, what legitimate admins will never request, and how to identify them. Rumble should publish similarly concrete rules wherever users may seek wallet or funding help.

## Recommended Rumble content blueprint

This is a compact adaptation that respects Rumble's existing product and design contracts.

### First viewport

- Product name.
- Promise: make a football call in Telegram; Rumble settles it from match data and produces a checkable receipt.
- One dominant **Add to Telegram group** deep link.
- The same action as a labelled QR code for a visitor on desktop or another device.
- A short recovery note: the link opens Telegram and asks which group to add Rumble to.
- A visible hint of one real, privacy-safe group offer or receipt—not a fake demo.

### One concise real journey

Use one real example rather than a feature tour:

1. A speaker intentionally makes or confirms a football call.
2. Rumble publishes deterministic “It happens” and “It does not” choices.
3. Members choose 0.01 SOL by default or choose an allowed larger amount.
4. TxLINE match data settles the call; unmatched SOL is refunded; a public aggregate receipt shows the proof state.

The example must not expose raw chat, wallet addresses, private balances, or individual positions.

### Trust and operating rules

State the important facts in plain language, with details available only when needed:

- Match data comes from TxLINE.
- Terms and settlement are deterministic; a model does not decide the result.
- Passive calls require the original speaker's confirmation before publication.
- Positions are peer-matched; unmatched SOL is refunded.
- The current product charges no fee.
- The active network is clearly identified.
- On devnet, test SOL has no monetary value; place this disclosure only where the product contract permits it.
- Public receipts use a stable group alias and aggregate data, never raw chat or private account information.

### Receipt/share surface

- Human-readable call and outcome.
- Aggregate happens/does-not amounts and matched amount.
- Settlement/refund/payout state.
- TxLINE evidence summary and honest Solana proof status.
- Short receipt URL.
- Optional QR for the same receipt when the artifact is intended to be shared as an image.
- One next action such as “Add Rumble to your group,” without referral or profit claims.

### Decision-blocker FAQ

Recommended questions:

1. What is Rumble?
2. How do I add Rumble to a Telegram group?
3. How does a football message become a call?
4. When does the speaker have to confirm?
5. What can group members choose, and how much SOL can they use?
6. How does matching, settlement, and the unmatched-SOL refund work?
7. Who decides the outcome?
8. What does the public receipt prove?
9. What is public, and what stays private?
10. Does Rumble charge a fee?
11. Is this mainnet or devnet, and does the SOL have monetary value?
12. I need help—what will legitimate Rumble support never ask me for?

If the landing page must remain extremely compact, link to a dedicated FAQ/help page and surface only the highest-risk blockers: consent, settlement/refunds, privacy, network/value, fees, and support safety.

### Footer resources

- Terms of Service.
- Privacy Policy.
- Help/support.
- Documentation or “How it works.”
- Proof/receipt explanation.
- Network status if one exists and is operationally reliable.

## Do not copy from BONKbot

- Do not claim “fastest,” “best,” “most popular,” “unfair advantage,” or similar superlatives without a defensible measurement and current evidence.
- Do not use profit, volume, or financial-upside testimonials for Rumble's devnet beta.
- Do not imply test SOL has monetary value.
- Do not add referral kickbacks or an alternate reward economy.
- Do not publish fake chats, fake receipts, replay onboarding, fake participants, or fake liquidity.
- Do not expose raw Telegram messages, personal identities, wallet addresses, balances, or individual positions on public surfaces.
- Do not turn the Rumble landing page into BONKbot's long instructional tour; keep the direct group-add journey dominant.
- Do not repeat the devnet disclaimer everywhere. Follow Rumble's explicit disclosure rules.
- Do not borrow BONKbot's language or testimonial copy verbatim; use this audit as a structural reference.

## Content QA checklist for future Rumble landing-page work

- [ ] Does the first screen say what Rumble is, where it works, and what the visitor should do?
- [ ] Is the primary Telegram action a real, versioned group-add deep link?
- [ ] Is a QR provided when it materially helps a desktop/second-device visitor?
- [ ] Does the QR resolve to the same safe destination as the adjacent link?
- [ ] Does every external link name the task or destination?
- [ ] Does a real product state support the hero promise?
- [ ] Are default amount, larger-amount control, consent, settlement, refunds, and fees stated accurately?
- [ ] Are TxLINE and Solana claims explained as evidence, not decoration?
- [ ] Is public proof privacy-safe and based on deterministic terms rather than raw chat?
- [ ] Are metrics defined, current, and backed by production data?
- [ ] Are testimonials permissioned, public, and non-fabricated?
- [ ] Does support guidance explain impersonation and private-key risks?
- [ ] Does every CTA preserve only the context its destination is authorized to receive?
- [ ] Are unsupported mainnet, profit, fee, referral, or reward claims absent?
- [ ] Does the page remain a compact product surface with one dominant add-to-group action?

## Source destinations observed

- [BONKbot landing page](https://bonkbot.io/)
- [BONKbot documentation](https://docs.bonkbot.io/)
- [BONKbot Telegram launch deep link](https://t.me/bonkbot_bot?start=ref_start)
- [BONKbot Telegram support](https://t.me/BONKbotChat)
- [Telegram install page](https://telegram.org/)
- [pump.fun](https://pump.fun/)
- [DEXScreener](https://dexscreener.com/)
- [Birdeye](https://birdeye.so/)
- [Telemetry](https://telemetry.io/)
- [Telemetry app](https://app.telemetry.io/)
