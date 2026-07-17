import type { SettlementOutcome, WagerAsset } from '@calledit/market-engine';
import type {
  CreatePendingStakeIntentResult,
  MutatePendingStakeIntentResult,
  PendingStakeIntentInput,
  ResolvePendingStakeIntentResult,
  VerifiedWalletLinkInput,
  VerifiedWalletLinkResult,
  WalletLinkSessionInput,
  WalletLinkSessionResult,
  WagerDepositInsert,
  WagerDepositRow,
  WagerLedgerEntry,
  WagerSettlementLedgerEntry,
  WagerStarterStakeInput,
  WagerStakeInput,
  WagerStakeResult,
  WagerStatusRow,
  WagerWalletLinkRow,
  WagerWithdrawResult,
  WagerWithdrawalRow,
  WagerWithdrawalState,
} from './wager-types.js';

export interface WagerFilterBuilder extends PromiseLike<import('./errors.js').PgResult<unknown>> {
  eq(column: string, value: unknown): WagerFilterBuilder;
  in(column: string, values: readonly unknown[]): WagerFilterBuilder;
  is(column: string, value: null): WagerFilterBuilder;
  select(columns?: string): WagerFilterBuilder;
  maybeSingle(): PromiseLike<import('./errors.js').PgResult<unknown>>;
}

export interface WagerTableBuilder {
  select(columns?: string): WagerFilterBuilder;
  upsert(
    values: object,
    options?: { onConflict?: string; ignoreDuplicates?: boolean },
  ): WagerFilterBuilder;
  update(values: object): WagerFilterBuilder;
  delete(): WagerFilterBuilder;
}

export interface WagerDbClient {
  from(table: string): WagerTableBuilder;
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<import('./errors.js').PgResult<unknown>>;
}

export interface StarterOnlyWagerDb {
  postWagerLedger(entry: WagerSettlementLedgerEntry): Promise<{ inserted: boolean }>;

  getMarketProbability(marketId: string): Promise<number | null>;
  getMarketAsset(marketId: string): Promise<WagerAsset | null>;
  getSettlementOutcome(marketId: string): Promise<SettlementOutcome | null>;
  hasSettlementApplied(marketId: string): Promise<boolean>;
  insertSettlementApplied(marketId: string): Promise<void>;
  settledWagerMarketsMissingApplied(): Promise<string[]>;
  /** Rolling-deploy compatibility alias for SOL-only callers. */
  settledSolMarketsMissingApplied(): Promise<string[]>;

  getWagerStatus(asset?: WagerAsset): Promise<WagerStatusRow>;
  wagerStarterStake(args: WagerStarterStakeInput): Promise<WagerStakeResult>;
}

export interface WagerDb {
  setGroupEnabled(groupId: number, enabled: boolean, byUserId: number): Promise<void>;
  isGroupEnabled(groupId: number): Promise<boolean>;
  setGroupDefaultAsset(groupId: number, asset: WagerAsset, byUserId: number): Promise<void>;
  groupDefaultAsset(groupId: number): Promise<WagerAsset>;

  getWalletLink(userId: number): Promise<WagerWalletLinkRow | null>;
  getWalletLinkByPubkey(pubkey: string): Promise<WagerWalletLinkRow | null>;
  setLastWagerGroup(userId: number, groupId: number): Promise<void>;

  postWagerLedger(entry: WagerLedgerEntry): Promise<{ inserted: boolean }>;
  stakeDebitedLamportsForMarket(marketId: string): Promise<bigint>;
  balanceLamports(userId: number, asset?: WagerAsset): Promise<bigint>;
  totalLedgerLamports(asset?: WagerAsset): Promise<bigint>;

  upsertDeposit(row: WagerDepositInsert): Promise<{ inserted: boolean }>;
  markDepositCredited(txSig: string, ixIndex: number, userId: number): Promise<void>;
  orphanDepositsBySender(pubkey: string): Promise<WagerDepositRow[]>;

  withdrawalsInState(state: WagerWithdrawalState): Promise<WagerWithdrawalRow[]>;
  markWithdrawalSubmitted(
    id: string,
    tx: { tx_sig: string; raw_tx_b64: string; last_valid_block_height: number },
  ): Promise<void>;
  markWithdrawalConfirmed(id: string): Promise<void>;
  markWithdrawalFailed(id: string, error: string): Promise<void>;

  getMarketProbability(marketId: string): Promise<number | null>;
  getMarketAsset(marketId: string): Promise<WagerAsset | null>;
  getSettlementOutcome(marketId: string): Promise<SettlementOutcome | null>;
  hasSettlementApplied(marketId: string): Promise<boolean>;
  insertSettlementApplied(marketId: string): Promise<void>;
  settledWagerMarketsMissingApplied(): Promise<string[]>;
  settledSolMarketsMissingApplied(): Promise<string[]>;
  settledFundedReplayMarketsMissingApplied(): Promise<string[]>;

  getWagerStatus(asset?: WagerAsset): Promise<WagerStatusRow>;
  setWagerStatus(asset: WagerAsset, paused: boolean, reason: string | null): Promise<void>;
  setWagerStatus(paused: boolean, reason: string | null): Promise<void>;

  openWagerMarkets(): Promise<Array<{ id: string; currency: WagerAsset }>>;
  openSolMarketIds(): Promise<string[]>;

  wagerStake(args: WagerStakeInput): Promise<WagerStakeResult>;
  requestWithdrawal(args: { user_id: number; asset?: WagerAsset; lamports: bigint }): Promise<WagerWithdrawResult>;

  verifyWalletLink(args: VerifiedWalletLinkInput): Promise<VerifiedWalletLinkResult>;
  createWalletLinkSession(args: WalletLinkSessionInput): Promise<WalletLinkSessionResult>;
  createPendingStakeIntent(args: PendingStakeIntentInput): Promise<CreatePendingStakeIntentResult>;
  resolveActiveStakeIntent(userId: number): Promise<ResolvePendingStakeIntentResult>;
  markStakeIntentFunded(userId: number, intentId: string): Promise<MutatePendingStakeIntentResult>;
  consumeReadyStakeIntent(userId: number, intentId: string): Promise<ResolvePendingStakeIntentResult>;
  cancelStakeIntent(userId: number, intentId: string): Promise<MutatePendingStakeIntentResult>;
}
