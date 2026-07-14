# Escrow V1 Wave 0 Protocol Review

Status: frozen for implementation

Source of truth: `escrow-plan.md` at commit `b58f921`. This review records the
implementation-level decisions needed to make that plan deterministic. It does
not expand the Version 1 product scope.

## Value-Moving Invariants

| Invariant | Program enforcement | Off-chain enforcement | Recovery path |
| --- | --- | --- | --- |
| Conservation | Checked `u64`/`u128` math; deposits precede accounting; claims cannot exceed the immutable entitlement | Indexer compares finalized vault balances with deposits, claims, and remaining liabilities | Pause new intake, reconcile, then continue claims or timeout voids |
| Asset isolation | Market asset and canonical mint are immutable; token program and every token account are validated | Engine and signing view fail closed on cluster, mint, program, or market mismatch | User claims from the same asset-specific vault |
| One side per wallet | `UserPosition.side` is immutable after the first successful lot | Signing session is bound to market and side | Same-side additions remain possible; opposite-side additions fail |
| Immutable terms | Market document hash, probability, ratio, cutoff, deadlines, fee, and oracle epoch are written once | Telegram, web, signer, and receipt use the same document hash | New quote creates a new market; an existing market is never repriced |
| Final settlement | State machine accepts one terminal transition | Signers independently rebuild the result | Threshold void or permissionless timeout void |
| Destination-bound claims | Claim destination is the recorded owner or its canonical ATA | Relayer cannot replace a destination | Anyone may relay the claim; only the owner receives value |
| Pause cannot trap funds | Pause is checked only by market initialization and placement | Readiness blocks new markets while unhealthy | Settlement, void, timeout, claim, and close remain callable |
| Retry safety | Market PDA, position PDA, lot nonce, terminal state, and claimed flag make effects single-use | Durable jobs persist bytes/signature and reconcile before rebuilding | Identical rebroadcast, then full-history lookup before re-signing |
| Legacy isolation | Escrow instructions have no access to the legacy treasury or ledger | Every market has an immutable custody version | Legacy balances remain withdrawable; no automatic migration exists |

## Narrow Safety Resolutions

### Probability quantization

The plan stores `probability_ppm` but the legacy reference currently accepts a
JavaScript `number`. Computing a ratio from the unquantized number off-chain and
from parts-per-million on-chain can produce different ratios near a rounding
boundary.

Escrow V1 therefore freezes this sequence:

1. Reject a probability that is not finite or is outside the configured quote
   bounds.
2. Compute `probability_ppm = round(probability * 1_000_000)` once.
3. Compute `ratio_milli` from that integer value with checked integer math and
   positive half-up rounding:

   ```text
   numerator = (1_000_000 - probability_ppm) * 1_000
   ratio_milli = max(1, floor((numerator + probability_ppm / 2) / probability_ppm))
   ```

4. Put both integers in the document, transaction, and market account.

Rust and TypeScript parity tests generate integer PPM inputs. The legacy custody
path keeps its existing quote and payout behavior.

### Residual vault value

The plan requires rounding dust to remain in the vault until final close but did
not define a close destination. Allowing a caller to supply that destination
would create an arbitrary withdrawal path.

Escrow V1 records a `residual_recipient` in `ProtocolConfig` and pins it into
each market at initialization. A market can transfer residual dust and account
rent only after every user position is claimed and every lot is resolved. The
destination is not an instruction argument. Changing the configured recipient
affects only markets created after the change. Mainnet ownership must be a
multisig-controlled operations address. No residual transfer is available while
any user entitlement remains.

### Canonical document size

The full claim specification and display terms can exceed a Solana transaction.
Escrow V1 therefore puts their canonical SHA-256 hashes, not their raw UTF-8
text, into the fixed-size market document. The engine and signing view retain
the text and verify it against those hashes. The program recomputes the complete
document hash from the validated fixed-size fields during initialization.

### Aggregate payout unit

The economic payout input is one `UserPosition` per wallet and market. Lots are
audit records that move amounts among that position's active, pending, and
refundable buckets. The unchanged payout equations apply once to each aggregate
position. Existing legacy markets keep their historical database-row rounding
and are never converted.

### Final forfeited total

The sum of floored losing forfeits cannot be reconstructed from market totals
alone. Accepting it from the relayer or settlement signers would let an
off-chain actor influence payouts.

After a valid threshold settlement, the market enters `settling`. A
permissionless `calculate_position_entitlement` transition processes each
aggregate `UserPosition` exactly once, computes its base refund with program
math, and accumulates losing forfeits. When the processed count reaches the
immutable position count, the program marks the market `settled`; winner claims
then use the finalized forfeited total. Pause never blocks this calculation or
claim flow. A void or timeout void remains directly refundable without the
calculation phase.

### Toolchain pin

Anchor `0.31.2` is not an official release. Escrow V1 pins Anchor `0.31.1`, the
published patch release in the requested `0.31` line, with its recommended
Solana `2.1.0` family. The CLI, Rust crates, generated IDL, and TypeScript adapter
must all use that same Anchor version.

## Frozen Account Budget

Sizes include the 8-byte Anchor discriminator. Rent figures use Solana
`Rent::default()` and are budget estimates that release tooling must re-check
against the target cluster before initialization.

| Account | Bytes | Estimated rent-exempt lamports |
| --- | ---: | ---: |
| `ProtocolConfig` | 379 | 3,528,720 |
| `OracleSet` (3 signers) | 136 | 1,837,440 |
| `Market` | 433 | 3,904,560 |
| `UserPosition` | 141 | 1,872,240 |
| `PositionLot` | 158 | 1,990,560 |
| Classic SPL token account | 165 | 2,039,280 |

The relayer may fund account rent, but every close destination is fixed by
protocol state. Rent sponsorship never gives the relayer authority over user
principal or claim destinations.

## Authority Matrix

| Operation | Required authority | May move user value | Available while paused | Justification |
| --- | --- | --- | --- | --- |
| Initialize config | Deployment initializer, once | No | N/A | Establish immutable program domain and separated roles |
| Update non-market config | Config multisig | No existing market value | No | Tightens limits and rotates future authorities |
| Rotate oracle set | Config multisig | No | No | Creates a new epoch; pinned markets do not change |
| Pause intake | Pause authority | No | Yes | Stops new risk quickly |
| Unpause intake | Config multisig | No | Yes | Requires stricter recovery approval |
| Initialize market | Market creation authority | No user value | No | Binds deterministic terms before placement |
| Freeze market | Feed operator | No | Yes | Can only reduce intake risk and increments event epoch |
| Unfreeze market | Threshold feed attestation | No | Yes | Prevents unilateral reopening after an event |
| Place position | User wallet signature; relayer may pay fees | Deposit only into that market vault | No | Explicit authorization for every position |
| Activate lot | Permissionless | No transfer | Yes | Same-epoch delay completion cannot redirect value |
| Invalidate lot | Threshold event attestation | Refund entitlement only | Yes | Price-moving evidence can only return user value |
| Settle market | 2-of-3 pinned settlement signers; permissionless submitter | Fixes entitlements | Yes | No single operator controls outcome |
| Void market | 2-of-3 pinned settlement signers; permissionless submitter | Refund entitlement only | Yes | Terminal recovery for cancellation or undecidable result |
| Timeout void | Permissionless after deadline | Refund entitlement only | Yes | Engine-independent liveness guarantee |
| Claim position | Permissionless fee payer | Owner-bound payout/refund | Yes | Relayer cannot redirect funds |
| Close lots/position/vault | Permissionless after all discharge checks | Residual only to pinned recipient | Yes | Reclaims rent without arbitrary destination control |

## Threat Review

| Threat | Required control | Release-blocking verification |
| --- | --- | --- |
| PDA or account substitution | Seed, owner, signer, market, mint, vault, and token-program constraints on every instruction | Adversarial local-validator tests |
| Fake or wrong-cluster USDC | Canonical classic SPL mint per genesis hash; Token-2022 rejected | Devnet/mainnet configuration mismatch tests and fake-mint tests |
| Compromised relayer | Relayer never signs user movement; all economic transitions are nonce/state/idempotency protected | Relayer key cannot place or redirect a claim |
| Single dishonest settlement signer | Pinned 2-of-3 threshold and domain-separated Ed25519 messages | Wrong signer, duplicate signer, expired, cross-market, cross-program, and cross-cluster tests |
| RPC timeout or fork | Persist transaction bytes/signature, query full history, index only finalized state, reconcile projections | Unknown-transaction, restart, reorg, and duplicate-delivery tests |
| Web transaction substitution | Server binds Telegram, Privy user, wallet, market, side, amount, asset, epoch, nonce, and expiry; browser decodes before signing | Tampered message and token replay tests |
| Privy or Telegram token disclosure | Short-lived single-use sessions; redact tokens and init data from logs | Logging privacy and session replay tests |
| Event-feed latency / anti-snipe | Pending lots observe an event epoch; activation requires unchanged epoch; invalidation requires threshold evidence | Freeze race, epoch mismatch, stale activation, and refund tests |
| Program pause abuse | Pause cannot guard settlement, void, timeout, claim, or close paths | Paused recovery matrix |
| Legacy/escrow accounting crossover | Immutable custody mode on market plus separate DB tables and code paths | No legacy ledger writes in escrow mode; legacy withdrawal regression |
| Upgrade/config authority compromise | Multisig before mainnet; authority-change monitoring; verifiable build | Mainnet gate only, never silently enabled |

## Release Boundaries

- `WAGER_CUSTODY_MODE=legacy` remains the default until an allowlisted devnet
  group explicitly selects escrow.
- `WAGER_CUSTODY_MODE=escrow` must fail closed when network, genesis hash,
  program ID, canonical mint, oracle epoch, signer threshold, indexer, or RPC
  readiness does not match.
- No code path automatically converts or transfers a legacy balance.
- Mainnet escrow deployment, authority changes, funding, and enablement remain an
  explicit approval gate.
