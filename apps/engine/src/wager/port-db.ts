import type {
  CreatePendingStakeIntentResult,
  MutatePendingStakeIntentResult,
  PendingStakeIntentInput,
  ResolvePendingStakeIntentResult,
  VerifiedWalletLinkInput,
  VerifiedWalletLinkResult,
  WagerDepositCreditResult,
  WagerLedgerEntry,
  WagerLegacyReconciliationSummary,
  WagerSolvencySnapshot,
  PendingStakeIntentRow,
  WalletLinkChallengeInput,
  WagerStakeInput,
  WagerStakeResult,
} from '@calledit/db';

export type {
  CreatePendingStakeIntentResult,
  MutatePendingStakeIntentResult,
  PendingStakeIntentInput,
  ResolvePendingStakeIntentResult,
  VerifiedWalletLinkInput,
  VerifiedWalletLinkResult,
  WagerDepositCreditResult,
  WagerLedgerEntry,
  WagerLegacyReconciliationSummary,
  WagerSolvencySnapshot,
  PendingStakeIntentRow,
  WalletLinkChallengeInput,
  WagerLedgerKind,
  WagerStakeErrorCode,
  WagerStakeInput,
  WagerStakeResult,
} from '@calledit/db';

export type WagerCurrency = 'rep' | 'sol';
export type WagerPositionSide = 'back' | 'doubt';
export type WagerPositionState = 'pending' | 'active' | 'void';
export type WagerSettlementOutcome = 'claim_won' | 'claim_lost' | 'void';

export interface WagerMarketRow {
  id: string;
  group_id: number;
  status: string;
  quote_probability: number;
  quote_multiplier: number;
}

export interface WagerPositionRow {
  id: string;
  market_id: string;
  user_id: number;
  side: WagerPositionSide;
  stake: number;
  locked_multiplier: number;
  state: WagerPositionState;
  placed_at_ms: number;
}

export interface WagerWalletLinkRow {
  user_id: number;
  pubkey: string;
  last_wager_group_id: number | null;
  verified_at: string | null;
  created_at: string;
}

export interface WagerDepositRow {
  tx_sig: string;
  ix_index: number;
  sender_pubkey: string;
  lamports: bigint;
  slot: number;
  user_id: number | null;
  credited_at: string | null;
  attribution_state: 'unattributed' | 'credited' | 'orphaned' | 'dust';
  attribution_reason:
    | 'below_minimum'
    | 'legacy_orphan'
    | 'unlinked_sender'
    | 'unverified_wallet'
    | 'stale_wallet'
    | null;
}

export type WagerWithdrawalState = 'debited' | 'submitted' | 'confirmed' | 'failed';

export interface WagerWithdrawalRow {
  id: string;
  user_id: number;
  dest_pubkey: string;
  lamports: bigint;
  state: WagerWithdrawalState;
  tx_sig: string | null;
  raw_tx_b64: string | null;
  last_valid_block_height: number | null;
  error: string | null;
}

export type WagerWithdrawErrorCode =
  | 'insufficient'
  | 'no_wallet'
  | 'wallet_unverified'
  | 'withdrawal_pending';

export type WagerWithdrawResult =
  | { ok: true; withdrawal_id: string }
  | { ok: false; code: WagerWithdrawErrorCode };

export interface WagerStatusRow {
  paused: boolean;
  reason: string | null;
}

export interface WagerDb {
  getWalletLink(userId: number): Promise<WagerWalletLinkRow | null>;
  getWalletLinkByPubkey(pubkey: string): Promise<WagerWalletLinkRow | null>;
  setLastWagerGroup(userId: number, groupId: number): Promise<void>;
  balanceLamports(userId: number): Promise<bigint>;
  totalLedgerLamports(): Promise<bigint>;
  postWagerLedger(entry: WagerLedgerEntry): Promise<{ inserted: boolean }>;
  wagerStake(args: WagerStakeInput): Promise<WagerStakeResult>;
  requestWithdrawal(args: { user_id: number; lamports: bigint }): Promise<WagerWithdrawResult>;
  upsertDeposit(row: {
    tx_sig: string;
    ix_index: number;
    sender_pubkey: string;
    lamports: bigint;
    slot: number;
  }): Promise<{ inserted: boolean }>;
  creditDepositToCurrentVerifiedWallet(args: {
    tx_sig: string;
    ix_index: number;
    min_lamports: bigint;
  }): Promise<WagerDepositCreditResult>;
  orphanDepositsBySender(pubkey: string): Promise<WagerDepositRow[]>;
  classifyLegacyWalletReconciliation(): Promise<WagerLegacyReconciliationSummary>;
  withdrawalsInState(state: 'debited' | 'submitted'): Promise<WagerWithdrawalRow[]>;
  markWithdrawalSubmitted(
    id: string,
    tx: { tx_sig: string; raw_tx_b64: string; last_valid_block_height: number },
  ): Promise<void>;
  markWithdrawalConfirmed(id: string): Promise<void>;
  markWithdrawalFailed(id: string, error: string): Promise<void>;
  positionsForMarket(marketId: string): Promise<WagerPositionRow[]>;
  setPositionStates(ids: string[], state: WagerPositionState): Promise<void>;
  getMarketProbability(marketId: string): Promise<number | null>;
  getSettlementOutcome(marketId: string): Promise<WagerSettlementOutcome | null>;
  hasSettlementApplied(marketId: string): Promise<boolean>;
  insertSettlementApplied(marketId: string): Promise<void>;
  settledSolMarketsMissingApplied(): Promise<string[]>;
  openSolMarketIds(): Promise<string[]>;
  getWagerStatus(): Promise<WagerStatusRow>;
  setWagerStatus(paused: boolean, reason: string | null): Promise<void>;
  setSolvencyStatus(paused: boolean, reason: string | null): Promise<void>;
  getSolvencySnapshot(): Promise<WagerSolvencySnapshot>;
  getCursor(streamName: string): Promise<string | null>;
  setCursor(streamName: string, value: string): Promise<void>;
  tryCronLock(name: string): Promise<boolean>;
  releaseCronLock(name: string): Promise<void>;
  getUserName(userId: number): Promise<string | null>;
  createWalletLinkChallenge(args: WalletLinkChallengeInput): Promise<void>;
  verifyWalletLink(args: VerifiedWalletLinkInput): Promise<VerifiedWalletLinkResult>;
  createPendingStakeIntent(args: PendingStakeIntentInput): Promise<CreatePendingStakeIntentResult>;
  resolveActiveStakeIntent(userId: number): Promise<ResolvePendingStakeIntentResult>;
  getPendingStakeIntent(userId: number, intentId: string): Promise<ResolvePendingStakeIntentResult>;
  markStakeIntentFunded(userId: number, intentId: string): Promise<MutatePendingStakeIntentResult>;
  consumeReadyStakeIntent(userId: number, intentId: string): Promise<ResolvePendingStakeIntentResult>;
  cancelStakeIntent(userId: number, intentId: string): Promise<MutatePendingStakeIntentResult>;
}
