/**
 * @calledit/solana — node-side entry point.
 * Browser code must import `@calledit/solana/verify` instead (isomorphic,
 * no web3.js in the bundle).
 */
export { loadWallet } from './wallet.js';
export { activationMessage, signActivation } from './activation.js';
export {
  buildSubscribeInstruction,
  buildValidateStatInstruction,
  deriveDailyScoresRootsPda,
  derivePricingMatrixPda,
  deriveSubscribeAccounts,
  deriveTokenTreasuryPda,
  PRICING_MATRIX_SEED,
  submitValidateStat,
  subscribeTxline,
  TOKEN_TREASURY_SEED,
  type BinaryOpInput,
  type ComparisonInput,
  type ProofNodeInput,
  type ScoresBatchSummaryInput,
  type ScoreStatInput,
  type StatTermInput,
  type SubmitValidateStatParams,
  type SubscribeAccounts,
  type TraderPredicateInput,
  type ValidateStatResult,
} from './txoracle.js';
export { TXORACLE_IDL } from './txoracle-idl.js';
export * from './verify.js';
export { base58Decode, base58Encode, bytesToHex, hexToBytes } from './codecs.js';

// Wager-mode chain I/O (pure, no DB knowledge; never-throw result objects).
export {
  broadcastRawTx,
  buildSolTransfer,
  getSigStatus,
  isBlockheightExceeded,
  resolveResubmitAction,
  type BlockheightExceededResult,
  type BlockHeightRpc,
  type BroadcastResult,
  type BroadcastRpc,
  type BuildSolTransferParams,
  type BuildSolTransferResult,
  type ConfirmationLevel,
  type ResubmitAction,
  type SignatureStatusLike,
  type SigStatusKnown,
  type SigStatusResult,
  type SigStatusRpc,
} from './transfer.js';
export {
  DEPOSIT_COMMITMENT,
  fetchIncomingTransfers,
  PARSED_TX_BATCH_SIZE,
  SIGNATURE_PAGE_LIMIT,
  type DepositScanRpc,
  type FetchIncomingTransfersOptions,
  type FetchIncomingTransfersResult,
  type IncomingTransfer,
  type ParsedInstructionLike,
  type ParsedTransactionLike,
  type SignatureInfoLike,
} from './deposits.js';
export { isRateLimitError, withRetry, type WithRetryOptions } from './rpc.js';

// Re-exported web3.js essentials so repo-root scripts (which have no direct
// node_modules access to web3.js under pnpm) can drive devnet through us.
export {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from '@solana/web3.js';
