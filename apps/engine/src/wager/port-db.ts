import type {
  CreatePendingStakeIntentResult,
  MutatePendingStakeIntentResult,
  PendingStakeIntentInput,
  ResolvePendingStakeIntentResult,
  WagerLedgerEntry,
  WagerStakeInput,
  WagerStakeResult,
} from '@calledit/db';
import type { MarketCurrency, WagerAsset } from '@calledit/market-engine';

export type {
  CreatePendingStakeIntentResult,
  MutatePendingStakeIntentResult,
  PendingStakeIntentInput,
  PendingStakeIntentRow,
  ResolvePendingStakeIntentResult,
  WagerLedgerEntry,
  WagerLedgerKind,
  WagerStakeErrorCode,
  WagerStakeInput,
  WagerStakeResult,
} from '@calledit/db';

export type WagerSettlementLedgerEntry = Omit<WagerLedgerEntry, 'kind'> & {
  readonly kind: 'payout' | 'refund';
};

export type WagerStarterStakeInput = Omit<WagerStakeInput, 'starterOnly'> & {
  readonly starterOnly?: never;
};

export type WagerCurrency = MarketCurrency;
export type WagerPositionSide = 'back' | 'doubt';
export type WagerPositionState = 'pending' | 'active' | 'void';
export type WagerSettlementOutcome = 'claim_won' | 'claim_lost' | 'void';

export interface WagerMarketRow {
  id: string;
  group_id: number;
  status: string;
  quote_probability: number;
  quote_multiplier: number;
  currency?: WagerAsset;
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
  asset: WagerAsset;
  mint_pubkey: string | null;
  lamports: bigint;
  slot: number;
  user_id: number | null;
  credited_at: string | null;
}

export type WagerWithdrawalState = 'debited' | 'submitted' | 'confirmed' | 'failed';

export interface WagerWithdrawalRow {
  id: string;
  user_id: number;
  dest_pubkey: string;
  asset: WagerAsset;
  lamports: bigint;
  state: WagerWithdrawalState;
  tx_sig: string | null;
  raw_tx_b64: string | null;
  last_valid_block_height: number | null;
  error: string | null;
}

export type WagerWithdrawErrorCode = 'insufficient' | 'no_wallet' | 'invalid_asset';

export type WagerWithdrawResult =
  | { ok: true; withdrawal_id: string }
  | { ok: false; code: WagerWithdrawErrorCode };

export interface WagerStatusRow {
  asset?: WagerAsset;
  paused: boolean;
  reason: string | null;
}

export interface WagerDb {
  getWalletLink(userId: number): Promise<WagerWalletLinkRow | null>;
  getWalletLinkByPubkey(pubkey: string): Promise<WagerWalletLinkRow | null>;
  createWalletLinkSession(args: {
    user_id: number;
    token_hash_hex: string;
    expires_at: string;
  }): Promise<
    | { ok: true; session_id: string }
    | { ok: false; code: 'session_invalid' | 'user_not_found' }
  >;
  createPendingStakeIntent(args: PendingStakeIntentInput): Promise<CreatePendingStakeIntentResult>;
  resolveActiveStakeIntent(userId: number): Promise<ResolvePendingStakeIntentResult>;
  markStakeIntentFunded(
    userId: number,
    intentId: string,
  ): Promise<MutatePendingStakeIntentResult>;
  consumeReadyStakeIntent(
    userId: number,
    intentId: string,
  ): Promise<ResolvePendingStakeIntentResult>;
  cancelStakeIntent(userId: number, intentId: string): Promise<MutatePendingStakeIntentResult>;
  setLastWagerGroup(userId: number, groupId: number): Promise<void>;
  setGroupDefaultAsset(groupId: number, asset: WagerAsset, byUserId: number): Promise<void>;
  groupDefaultAsset(groupId: number): Promise<WagerAsset>;
  balanceLamports(userId: number, asset: WagerAsset): Promise<bigint>;
  totalLedgerLamports(asset: WagerAsset): Promise<bigint>;
  postWagerLedger(entry: WagerLedgerEntry): Promise<{ inserted: boolean }>;
  stakeDebitedLamportsForMarket(marketId: string): Promise<bigint>;
  wagerStake(args: WagerStakeInput): Promise<WagerStakeResult>;
  requestWithdrawal(args: {
    user_id: number;
    asset?: WagerAsset;
    lamports: bigint;
  }): Promise<WagerWithdrawResult>;
  upsertDeposit(row: {
    tx_sig: string;
    ix_index: number;
    sender_pubkey: string;
    asset: WagerAsset;
    mint_pubkey: string | null;
    lamports: bigint;
    slot: number;
  }): Promise<{ inserted: boolean }>;
  markDepositCredited(txSig: string, ixIndex: number, userId: number): Promise<void>;
  orphanDepositsBySender(pubkey: string): Promise<WagerDepositRow[]>;
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
  getMarketAsset(marketId: string): Promise<WagerAsset | null>;
  getSettlementOutcome(marketId: string): Promise<WagerSettlementOutcome | null>;
  hasSettlementApplied(marketId: string): Promise<boolean>;
  insertSettlementApplied(marketId: string): Promise<void>;
  settledWagerMarketsMissingApplied(): Promise<string[]>;
  settledSolMarketsMissingApplied(): Promise<string[]>;
  settledFundedReplayMarketsMissingApplied(): Promise<string[]>;
  openWagerMarkets(): Promise<Array<{ id: string; currency: WagerAsset }>>;
  openSolMarketIds(): Promise<string[]>;
  getWagerStatus(asset?: WagerAsset): Promise<WagerStatusRow>;
  setWagerStatus(
    assetOrPaused: WagerAsset | boolean,
    pausedOrReason: boolean | string | null,
    reason?: string | null,
  ): Promise<void>;
  getCursor(streamName: string): Promise<string | null>;
  setCursor(streamName: string, value: string): Promise<void>;
  tryCronLock(name: string): Promise<boolean>;
  releaseCronLock(name: string): Promise<void>;
  getUserName(userId: number): Promise<string | null>;
  getUserNames(userIds: readonly number[]): Promise<ReadonlyMap<number, string>>;
}

type WagerSettlementReadDb = Pick<
  WagerDb,
  | 'getMarketProbability'
  | 'getMarketAsset'
  | 'getSettlementOutcome'
  | 'hasSettlementApplied'
  | 'positionsForMarket'
  | 'setPositionStates'
  | 'insertSettlementApplied'
  | 'settledWagerMarketsMissingApplied'
  | 'settledSolMarketsMissingApplied'
  | 'getUserNames'
>;

export interface WagerSettlementDb extends WagerSettlementReadDb {
  postWagerLedger(entry: WagerSettlementLedgerEntry): Promise<{ inserted: boolean }>;
  stakeDebitedLamportsForMarket?: (marketId: string) => Promise<bigint>;
  settledFundedReplayMarketsMissingApplied?: () => Promise<string[]>;
}

export interface StarterOnlyWagerDb extends WagerSettlementDb {
  getWagerStatus(asset?: WagerAsset): ReturnType<WagerDb['getWagerStatus']>;
  wagerStarterStake(args: WagerStarterStakeInput): Promise<WagerStakeResult>;
}
