# Called It Escrow SDK Protocol V1

This package is the TypeScript reference for the Escrow V1 byte protocol. The
Rust program must reproduce the bytes in `vectors/canonical-v1.json` exactly.

## Primitive encoding

- All integers are little-endian.
- Amounts, fixture IDs, epochs, nonces, sequences, and ratios are unsigned
  64-bit integers unless listed otherwise.
- Timestamps are signed 64-bit Unix seconds.
- Probabilities are unsigned 32-bit parts per million.
- Fees and score components are unsigned 16-bit integers.
- Booleans are one byte: `0` or `1`.
- Public keys and hashes are exactly 32 raw bytes.
- Market UUIDs are exactly 16 RFC 4122 bytes from canonical `8-4-4-4-12` text.
- `string16` and `string32` are UTF-8 prefixed by a little-endian `u16` or
  `u32` byte length. No terminator or padding is present.
- Every document starts with `string16(domain)` followed by schema byte `1`.
- Every hash is SHA-256 over the complete canonical document bytes.

## Market document

Domain: `calledit.escrow.market.v1`

Fields after the header, in order:

1. market UUID (`[u8; 16]`)
2. fixture ID (`u64`)
3. canonical claim specification (`string32`, maximum 4096 bytes)
4. display terms (`string32`, maximum 1024 bytes)
5. asset (`u8`: SOL `0`, USDC `1`)
6. probability PPM (`u32`, `1..=999999`)
7. ratio milli (`u32`)
8. odds message hash (`[u8; 32]`)
9. odds timestamp (`i64`)
10. position cutoff (`i64`)
11. resolution deadline (`i64`)
12. fee BPS (`u16`, must be zero in V1)
13. oracle-set epoch (`u64`)
14. replay flag (`bool`)

The escrow ratio is derived only from integer PPM:

```text
numerator = (1_000_000 - probability_ppm) * 1_000
ratio_milli = max(1, floor((numerator + floor(probability_ppm / 2)) /
                           probability_ppm))
```

`ratioMilliFromProbability` is a legacy compatibility helper and is not valid
for creating an escrow market.

## Attestations

All five attestations begin with their domain and schema byte, then this common
body:

1. cluster genesis hash (`[u8; 32]`)
2. escrow program ID (`[u8; 32]`)
3. market PDA (`[u8; 32]`)
4. market document hash (`[u8; 32]`)
5. fixture ID (`u64`)
6. oracle-set epoch (`u64`)
7. issued timestamp (`i64`)
8. expiry timestamp (`i64`)
9. evidence hash (`[u8; 32]`)

The expiry must be later than issuance.

| Attestation | Domain | Kind-specific body |
| --- | --- | --- |
| Quote | `calledit.escrow.attestation.quote.v1` | probability PPM `u32`, ratio `u32`, odds timestamp `i64` |
| Feed event | `calledit.escrow.attestation.feed-event.v1` | kind `u8` (`freeze=0`, `unfreeze=1`, `price_moving=2`), event epoch `u64`, deciding sequence `u64`, observed timestamp `i64` |
| Position invalidation | `calledit.escrow.attestation.position-invalidation.v1` | lot PDA `[u8;32]`, lot nonce `u64`, observed epoch `u64`, invalidated epoch `u64`, deciding sequence `u64` |
| Settlement | `calledit.escrow.attestation.settlement.v1` | outcome `u8` (`claim_won=0`, `claim_lost=1`), deciding sequence `u64`, terminal phase `string16` (maximum 32 bytes), optional regulation score, optional full-match score, evidence sequence commitment `[u8;32]`, normalized evidence root `[u8;32]` |
| Void | `calledit.escrow.attestation.void.v1` | reason `u8` (`cancelled=0`, `abandoned=1`, `coverage_loss=2`, `undecidable=3`), deciding sequence `u64` |

An optional score is a one-byte presence flag followed, when present, by home
and away `u16` values.

## PDA seeds

| Account | Seeds |
| --- | --- |
| Protocol config | `"config"` |
| Oracle set | `"oracle-set"`, epoch `u64 LE` |
| Market | `"market"`, UUID bytes |
| User position | `"position"`, market key, owner key |
| Position lot | `"lot"`, market key, owner key, nonce `u64 LE` |
| SOL vault | `"vault"`, market key |
| USDC vault | Canonical classic SPL associated token account for the market PDA and configured mint |

## Residual destination

`ProtocolConfig.residualRecipient` is pinned into every new `Market`. The
`close_market` request contains no destination. Dust and rent may move only to
the pinned recipient after all positions are claimed and all lots are resolved.
