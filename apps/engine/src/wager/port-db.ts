import type {
  WagerLedgerEntry,
  WagerStakeInput,
  WagerStakeResult,
} from '@calledit/db';

export type {
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

export type WagerWithdrawErrorCode = 'insufficient' | 'no_wallet';

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
  getSettlementOutcome(marketId: string): Promise<WagerSettlementOutcome | null>;
  hasSettlementApplied(marketId: string): Promise<boolean>;
  insertSettlementApplied(marketId: string): Promise<void>;
  settledSolMarketsMissingApplied(): Promise<string[]>;
  openSolMarketIds(): Promise<string[]>;
  getWagerStatus(): Promise<WagerStatusRow>;
  setWagerStatus(paused: boolean, reason: string | null): Promise<void>;
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
  | 'getSettlementOutcome'
  | 'hasSettlementApplied'
  | 'positionsForMarket'
  | 'setPositionStates'
  | 'insertSettlementApplied'
  | 'settledSolMarketsMissingApplied'
  | 'getUserNames'
>;

export interface WagerSettlementDb extends WagerSettlementReadDb {
  postWagerLedger(entry: WagerSettlementLedgerEntry): Promise<{ inserted: boolean }>;
}

export interface StarterOnlyWagerDb extends WagerSettlementDb {
  getWagerStatus(): ReturnType<WagerDb['getWagerStatus']>;
  wagerStarterStake(args: WagerStarterStakeInput): Promise<WagerStakeResult>;
}
