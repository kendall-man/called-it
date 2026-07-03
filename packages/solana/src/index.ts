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

// Re-exported web3.js essentials so repo-root scripts (which have no direct
// node_modules access to web3.js under pnpm) can drive devnet through us.
export {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from '@solana/web3.js';
