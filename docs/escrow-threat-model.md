# Escrow Threat Model

## Scope And Security Objective

The escrow system holds native SOL or canonical classic-SPL USDC in one vault
per market. A Privy-controlled user wallet signs every placement. The program,
not the engine or database, enforces the market identity, asset, amount, side,
price, event epoch, cutoff, settlement finality, entitlement, and claim
destination.

The primary objective is conservation and recoverability:

```text
successful deposits = paid claims + outstanding entitlements + explicit residual
```

No administrator, operator, relayer, signer, web server, database role, or
support process may arbitrarily withdraw a market vault or redirect a user's
claim. Legacy custodial balances remain separate and withdrawable. There is no
automatic migration.

## Trust Boundaries

| Boundary | Trusted for | Not trusted for |
| --- | --- | --- |
| Escrow program | Account validation, custody, state transitions, payout math, destination binding | Off-chain match truth before threshold attestation |
| Privy/user wallet | User authorization over exact transaction bytes | Market terms, price, settlement truth |
| Engine/Telegram/web | UX, deterministic transaction construction, durable relay, chain-derived display | Custody, private keys, unilateral settlement, payout mutation |
| 2-of-3 oracle set | Threshold terminal result and event attestations | Vault access, destination choice, config changes |
| RPC providers | Transport of finalized chain state | Identity unless genesis/program/config are independently verified |
| Supabase/indexer | Search, cards, receipts, job durability | Settlement truth or source of balances |
| Relayer | Fee payment and exact signed-byte broadcast | Rebuilding signed intent, changing accounts/data, declaring failure after timeout |
| Protocol authorities | Narrow config, pause, market creation, feed, upgrade duties | User claims, vault sweep, settled entitlement rewrite |
| Legacy treasury | Existing custodial withdrawal liabilities only | Escrow market funding or automatic conversion |

## Frozen Invariants

- Separate devnet and mainnet program IDs, genesis hashes, configuration, oracle
  epochs, authorities, and canonical USDC mints.
- Classic SPL Token program and six-decimal canonical USDC only.
- Per-market SOL PDA vault or market-PDA USDC ATA.
- Immutable market document, ratio, asset, cutoff, deadline, and oracle epoch.
- Pre-match lots activate immediately. In-play lots remain pending for the
  fixed delay and observed event epoch; invalidation can only add a refund.
- Settlement requires two distinct signatures from the pinned three-key set.
- Payout floor rounding matches the TypeScript model at aggregate user-position
  granularity; total entitlement never exceeds deposits.
- Claims are permissionless to submit but pay only the recorded owner or its
  canonical ATA.
- Pause stops intake only. Claims, refunds, settlement, signed void, and timeout
  void remain available.
- There is no `withdraw_vault`, generic transfer, migration, or administrator
  entitlement-edit instruction.

## Threats And Controls

| Threat | Impact | Preventive controls | Detection/recovery |
| --- | --- | --- | --- |
| Wrong cluster or program substitution | User signs against attacker or wrong deployment | Genesis, program ID, config PDA, oracle PDA, mint, token program, full v0 message, blockhash, and signer-set verification | Release verifier and browser pre-sign verifier fail closed |
| Upgrade/config authority compromise | Malicious code or configuration | Separate roles, multisig before mainnet, low allowlisted canary, reproducible SBF/IDL/source hashes | Authority-change alert, pause intake, independent binary/config verification |
| Arbitrary vault withdrawal path | Asset theft | No admin withdrawal instruction; IDL policy rejects sweep/drain/admin-transfer shapes; destination-bound claims | CI/release gate blocks IDL; direct account reconciliation |
| Fake USDC or Token-2022 substitution | Worthless or incompatible asset accepted | Exact canonical mint, classic Token program owner, Mint layout, initialized state, six decimals | Release verification and program account constraints |
| Relayer transaction mutation | Wrong asset, amount, side, account, or destination | Browser verifies exact serialized message and sponsor signature; user signature covers immutable message | Signature verification, durable signed bytes, no re-sign after expiry |
| RPC equivocation/outage | False state or duplicate retry | Finalized reads, genesis/config/program checks, provider agreement, timeout treated as unknown | Intake closes; query original signature on independent matching RPC |
| Oracle equivocation or stale signature | Incorrect settlement or event invalidation | Exact 2-of-3 unique signers, domain separation, market/fixture/evidence/epoch/expiry binding | Disagreement alert; wait for timeout void if threshold unavailable |
| In-play delayed-feed sniping | Unfair active position | Pending lots, immutable delay, event epoch, threshold invalidation that only refunds | Stale-lot monitoring and event/lot reconciliation |
| Payout rounding divergence | Insolvency or unfair allocation | Checked integer math, aggregate-owner floors, Rust/TypeScript differential and conservation tests | Vault-liability drift hard alert; intake closes |
| Claim destination substitution | Theft during claim-for | Owner fixed in position PDA; SOL owner and canonical USDC ATA derived and checked | Adversarial destination test and direct claim fallback |
| Double placement/claim/retry | Duplicate value movement | Lot nonce, signing-session single use, transaction signature, idempotent jobs/events, claimed flag | Dead/unknown job monitor and finalized reconciliation |
| Pause used as ransom | Users cannot recover | Recovery instructions do not depend on pause authority or paused state | IDL policy, paused direct-claim and timeout-void release evidence |
| Indexer/database corruption | False Telegram card or receipt | Finalized chain is source of truth; cursor and event idempotency | Rebuild from verified cursor and reconcile chain-to-database |
| Credential leakage | Wallet/account takeover | No private keys, auth tokens, init data, RPC credentials, or raw JWTs in logs/evidence | CLI rejects credential-like JSON fields and redacts URL/error output |
| Legacy/escrow cross-accounting | Loss or accidental migration | Explicit custody mode, separate ledgers/jobs/copy, legacy withdrawal-only path | Liability audit, no-auto-migration evidence, dual-mode regression tests |
| Denial of service or fee starvation | Placement/claim delay | Relayer reserve, direct permissionless claims, independent RPC, timeout recovery | Reserve/backlog/lag alerts; users can claim without engine |

## Authority Separation

Upgrade, config, pause, market creation, feed operation, relayer fee payment, and
oracle signing are distinct identities. Oracle signers are independent of all
operational authorities. Mainnet upgrade, config, pause, market-creation,
feed-operator, and oracle-set control must have machine-readable multisig
evidence. The oracle set is exactly 2-of-3.

Rotation must not silently change old markets. A market pins its oracle epoch
and immutable terms. A compromised non-upgrade authority is rotated only after
intake is closed and existing recovery paths are verified. An upgrade is a last
resort for reviewed defects, never a way to rewrite settled entitlements.

## Release And Incident Assumptions

The release gate assumes evidence artifacts are independently produced,
content-addressed, reviewed, and access-controlled. A JSON assertion alone is
not proof; its referenced artifact must exist in the release record. Fake
fixtures in the repository are only parser examples.

Mainnet remains disabled until two reproducible builds match, the deployed
release verifier passes, local-validator and real devnet SOL/USDC paths pass,
seven calendar days are drift-clean, direct recovery works with services down
and pause active, independent review and external audit have no open
critical/high findings, authorities are multisig-controlled, and explicit
mainnet canary approval exists.

Residual risks include Solana runtime defects, Privy compromise, collusion of
two oracle signers, compromise of a controlling multisig threshold, flaws not
found by review/audit, and chain-wide finality failure. Mitigation is limited
exposure: separate identities, low per-position caps, a small group allowlist,
no protocol fee, rapid intake pause, direct recovery, continuous
reconciliation, and no claim that confirmed transactions can be reversed.
