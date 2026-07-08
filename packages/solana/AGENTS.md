# packages/solana

## Overview

Solana devnet helpers for TxLINE activation/proof submission plus isomorphic receipt
verification code used by the web app.

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| Node entry | `src/index.ts` | Wallet, txoracle, wager transfer/deposit exports |
| Browser-safe verify | `src/verify.ts` | No node-only imports or web3.js |
| Txoracle client | `src/txoracle.ts` | Subscribe and validate-stat instructions |
| Activation signing | `src/activation.ts` | GLM/TxLINE bootstrap signature material |
| Transfers | `src/transfer.ts` | Wager withdrawal build/broadcast/status logic |
| Deposits | `src/deposits.ts` | Treasury incoming transfer scanner |
| Codecs | `src/codecs.ts` | Base58/base64/hex/hash helpers |

## Conventions

- Keep `src/verify.ts` isomorphic. It is bundled by the web app through `solana-verify-bridge`.
- Chain/proof failure should return structured failure or null where callers expect degradation.
- Do not mix the TxL wallet secret with wager treasury funds.
- Tests use synthetic vectors/fixtures; avoid network-dependent tests by default.

## Commands

```bash
npx -y pnpm@10.33.0 --filter @calledit/solana typecheck
npx -y pnpm@10.33.0 --filter @calledit/solana test
npx -y pnpm@10.33.0 --filter @calledit/solana build
```

## Gotchas

- Tests may print `bigint: Failed to load bindings, pure JS will be used`; current suite passes.
- `TXORACLE_IDL` is large and intentionally generated/static.
