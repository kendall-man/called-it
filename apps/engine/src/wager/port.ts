/**
 * wager/port.ts — the frozen WagerModule contract (docs/wager-feature-design.md)
 * plus STRUCTURAL mirrors of every cross-slice surface this module consumes:
 * the WagerDb facade (packages/db, built concurrently), the chain I/O surface
 * (packages/solana transfer/deposits/rpc), and the engine seams (poster,
 * logger, cron registry, bot command registration).
 *
 * Sibling slices land in parallel, so nothing under wager/ imports their new
 * files directly — wiring.ts binds the real implementations to these shapes at
 * integration and TypeScript's structural typing reconciles them. Field names
 * deliberately match the sibling slices' declared shapes so the adapters in
 * wiring are pass-throughs.
 */

// ── Shared engine row shapes (structural mirrors of ../ports.ts) ──────────

export type WagerCurrency = 'rep' | 'sol';
export type WagerPositionSide = 'back' | 'doubt';
export type WagerPositionState = 'pending' | 'active' | 'void';
export type WagerSettlementOutcome = 'claim_won' | 'claim_lost' | 'void';

/** Structural subset of MarketRow — the real row satisfies this at the seam. */
export interface WagerMarketRow {
  id: string;
  group_id: number;
  status: string;
  quote_probability: number;
  quote_multiplier: number;
}

/**
 * Structural subset of PositionRow (positions is a SHARED table — sol markets
 * reuse the Rep lifecycle). For sol markets `stake` holds lamports as a JS
 * number; every consumer here asserts Number.isSafeInteger before bigint math.
 */
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

// ── WagerDb facade (implemented by packages/db/src/wager-db.ts) ────────────

export type WagerLedgerKind =
  | 'deposit'
  | 'stake'
  | 'payout'
  | 'refund'
  | 'withdrawal'
  | 'withdrawal_refund';

export interface WagerLedgerEntry {
  user_id: number;
  group_id: number | null;
  market_id: string | null;
  kind: WagerLedgerKind;
  /** Signed lamports delta. Balance is USER-GLOBAL (sum by user_id). */
  lamports: bigint;
  idempotency_key: string;
}

export interface WagerWalletLinkRow {
  user_id: number;
  pubkey: string;
  /** NOTIFICATION routing only (group post, never DM) — never fund routing. */
  last_wager_group_id: number | null;
  verified_at: string | null;
  created_at: string;
}

export type WalletLinkResult =
  /** relinked=true when the user replaced an earlier link of their own. */
  | { ok: true; relinked: boolean }
  /** First-link-wins: the pubkey is already claimed by another user. */
  | { ok: false; reason: 'pubkey_taken' };

export interface WagerDepositRow {
  tx_sig: string;
  ix_index: number;
  sender_pubkey: string;
  lamports: bigint;
  slot: number;
  /** null = orphan (sender pubkey not linked to any user when observed). */
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

export type WagerStakeErrorCode =
  | 'insufficient'
  | 'wrong_side'
  | 'cap'
  | 'liability_cap'
  | 'paused';

export type WagerStakeResult =
  | { ok: true; position_id: string }
  | { ok: false; code: WagerStakeErrorCode };

export type WagerWithdrawErrorCode = 'insufficient' | 'no_wallet';

export type WagerWithdrawResult =
  | { ok: true; withdrawal_id: string }
  | { ok: false; code: WagerWithdrawErrorCode };

export interface WagerStatusRow {
  paused: boolean;
  reason: string | null;
}

/**
 * The engine's view of packages/db's wager facade. All lamports cross this
 * boundary as bigint — the facade owns PostgREST number conversion and its
 * Number.isSafeInteger asserts.
 */
export interface WagerDb {
  // group opt-in
  setGroupEnabled(groupId: number, enabled: boolean, byUserId: number): Promise<void>;
  isGroupEnabled(groupId: number): Promise<boolean>;

  // wallet links
  getWalletLink(userId: number): Promise<WagerWalletLinkRow | null>;
  getWalletLinkByPubkey(pubkey: string): Promise<WagerWalletLinkRow | null>;
  linkWallet(input: { user_id: number; pubkey: string }): Promise<WalletLinkResult>;
  setLastWagerGroup(userId: number, groupId: number): Promise<void>;

  // ledger (user-global lamport balances)
  balanceLamports(userId: number): Promise<bigint>;
  /** Σ over ALL wager_ledger_entries — total user credit the treasury owes. */
  totalLedgerLamports(): Promise<bigint>;
  /** Idempotent append; inserted=false when the idempotency key exists. */
  postWagerLedger(entry: WagerLedgerEntry): Promise<{ inserted: boolean }>;

  // atomic security-definer RPCs (pg_advisory_xact_lock per user inside)
  wagerStake(args: {
    user_id: number;
    group_id: number;
    market_id: string;
    side: WagerPositionSide;
    lamports: bigint;
    multiplier: number;
    state: 'pending' | 'active';
    placed_at_ms: number;
  }): Promise<WagerStakeResult>;
  /** dest_pubkey is resolved from the wallet link INSIDE the function. */
  requestWithdrawal(args: { user_id: number; lamports: bigint }): Promise<WagerWithdrawResult>;

  // deposits (idempotent on UNIQUE(tx_sig, ix_index))
  upsertDeposit(row: {
    tx_sig: string;
    ix_index: number;
    sender_pubkey: string;
    lamports: bigint;
    slot: number;
  }): Promise<{ inserted: boolean }>;
  markDepositCredited(txSig: string, ixIndex: number, userId: number): Promise<void>;
  /** Uncredited rows (user_id null) from this sender — the /wallet link sweep. */
  orphanDepositsBySender(pubkey: string): Promise<WagerDepositRow[]>;

  // withdrawals outbox
  withdrawalsInState(state: 'debited' | 'submitted'): Promise<WagerWithdrawalRow[]>;
  markWithdrawalSubmitted(
    id: string,
    tx: { tx_sig: string; raw_tx_b64: string; last_valid_block_height: number },
  ): Promise<void>;
  markWithdrawalConfirmed(id: string): Promise<void>;
  markWithdrawalFailed(id: string, error: string): Promise<void>;

  // shared markets/positions/settlements — sol paths only
  positionsForMarket(marketId: string): Promise<WagerPositionRow[]>;
  setPositionStates(ids: string[], state: WagerPositionState): Promise<void>;
  getSettlementOutcome(marketId: string): Promise<WagerSettlementOutcome | null>;
  hasSettlementApplied(marketId: string): Promise<boolean>;
  insertSettlementApplied(marketId: string): Promise<void>;
  /** settled/voided sol markets lacking the wager_settlements_applied marker. */
  settledSolMarketsMissingApplied(): Promise<string[]>;
  /** Non-terminal sol markets — the solvency liability scan. */
  openSolMarketIds(): Promise<string[]>;

  // persisted circuit breaker (wager_status single row)
  getWagerStatus(): Promise<WagerStatusRow>;
  setWagerStatus(paused: boolean, reason: string | null): Promise<void>;

  // stream cursors (shared stream_cursors table) + cron singleton locks
  getCursor(streamName: string): Promise<string | null>;
  setCursor(streamName: string, value: string): Promise<void>;
  /** pg advisory try-lock so rolling-deploy overlap cannot double-run a cron. */
  tryCronLock(name: string): Promise<boolean>;
  releaseCronLock(name: string): Promise<void>;

  // shared users table — display names for chat lines
  getUserName(userId: number): Promise<string | null>;
}

// ── Chain I/O (packages/solana transfer/deposits/rpc, bound in wiring) ────
// House never-throw result objects; wiring composes Connection + the
// dedicated wager treasury keypair (NEVER the TxL SOLANA_KEYPAIR_B58).

export type WagerBuiltTransfer =
  | { ok: true; sig: string; rawTxB64: string; lastValidBlockHeight: number }
  /** permanent=true means retrying cannot help (e.g. unparseable dest). */
  | { ok: false; error: string; permanent?: boolean };

export type WagerBroadcastResult = { ok: true } | { ok: false; error: string };

export type WagerSigStatus =
  | {
      ok: true;
      found: true;
      confirmationStatus: 'processed' | 'confirmed' | 'finalized';
      /** JSON-stringified on-chain error, or null when the tx succeeded. */
      err: string | null;
    }
  /**
   * Genuinely never landed — the implementation MUST query with
   * searchTransactionHistory:true, otherwise a long-confirmed withdrawal
   * reads as absent after a crash and gets re-signed (a double-send).
   */
  | { ok: true; found: false }
  | { ok: false; error: string };

export type WagerBlockheightCheck =
  | { ok: true; exceeded: boolean }
  | { ok: false; error: string };

export interface WagerIncomingTransfer {
  sig: string;
  /** One tx can carry several transfers to the treasury — each credits separately. */
  ixIndex: number;
  /** Sender pubkey (base58) — matched against wallet links. */
  sender: string;
  lamports: bigint;
  slot: number;
}

export type WagerDepositScan =
  | {
      ok: true;
      /** Oldest-first — ready for in-order, per-signature cursor advance. */
      transfers: WagerIncomingTransfer[];
      /** Newest signature scanned (even if transfer-free spam/dust). */
      newestSig: string | null;
    }
  | { ok: false; error: string };

export type WagerBalanceResult =
  | { ok: true; lamports: bigint }
  | { ok: false; error: string };

export type WagerAirdropResult = { ok: true; sig: string } | { ok: false; error: string };

export interface WagerChain {
  /** The dedicated wager treasury address (safe to show in chat). */
  treasuryPubkey(): string;
  treasuryBalanceLamports(): Promise<WagerBalanceResult>;
  /**
   * Fetch a fresh blockhash, build and locally sign a treasury→dest transfer.
   * The signature is known PRE-broadcast; identical bytes ⇒ identical sig, so
   * rebroadcast is always safe.
   */
  buildTransfer(args: { to: string; lamports: bigint }): Promise<WagerBuiltTransfer>;
  broadcastRawTx(rawTxB64: string): Promise<WagerBroadcastResult>;
  getSigStatus(sig: string): Promise<WagerSigStatus>;
  isBlockheightExceeded(lastValidBlockHeight: number): Promise<WagerBlockheightCheck>;
  /** Incoming system transfers to the treasury newer than the cursor sig. */
  fetchIncomingTransfers(args: { untilSig: string | null }): Promise<WagerDepositScan>;
  /** Devnet float top-up. Rate-limit failures are expected — warn, don't throw. */
  requestAirdrop(lamports: bigint): Promise<WagerAirdropResult>;
}

// ── Engine seams (structural subsets of Poster / Logger / grammy Bot) ─────

export interface WagerPoster {
  post(chatId: number, text: string): void;
}

export interface WagerLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

/** The seams slice adapts its cron loop to this one-method registry. */
export interface WagerCronRegistry {
  every(intervalMs: number, task: () => void | Promise<void>): void;
}

/** Structural subset of grammy's CommandContext — fakes stay trivial. */
export interface WagerCommandCtx {
  chat?: { id: number; type: string };
  from?: { id: number; first_name: string; last_name?: string };
  match?: string | RegExpMatchArray;
  reply(text: string): Promise<unknown>;
}

/** Structural subset of grammy's Bot (method bivariance lets Bot satisfy it). */
export interface WagerBotLike {
  command(command: string, handler: (ctx: WagerCommandCtx) => Promise<void>): unknown;
}

// ── The frozen WagerModule surface ─────────────────────────────────────────

export interface WagerStakeTapArgs {
  market: WagerMarketRow;
  userId: number;
  userName: string;
  side: WagerPositionSide;
  presetIndex: number;
  inPlay: boolean;
  nowMs: number;
}

export interface WagerModule {
  /** 'sol' when the group has wager mode on — stamped atomically at mint. */
  currencyForMint(groupId: number): Promise<WagerCurrency>;
  /** The sol-market branch of handleStake; reply is the callback-answer text. */
  handleStakeTap(args: WagerStakeTapArgs): Promise<{ reply: string; placed: boolean }>;
  /** Idempotent money movement for a settled/voided sol market. */
  applySettlement(marketId: string): Promise<void>;
  /** Chat receipt line (SOL amounts are chat-only; public_receipts untouched). */
  settlementPayoutsLine(marketId: string, outcome: WagerSettlementOutcome): Promise<string>;
  cardFooter(): string;
  presetLabels(): [string, string, string];
  /**
   * Flips the per-group flag and returns the group-facing toggle explainer —
   * ALL wager copy lives in wager/copy.ts, so the line must flow out through
   * the module surface rather than be composed at the seam.
   */
  setGroupEnabled(groupId: number, enabled: boolean, byUserId: number): Promise<string>;
  isGroupEnabled(groupId: number): Promise<boolean>;
  registerCommands(bot: WagerBotLike): void;
  registerCrons(registry: WagerCronRegistry): void;
}

/** Constructor bundle assembled by wiring.ts (module is null when flag off). */
export interface WagerModuleDeps {
  db: WagerDb;
  chain: WagerChain;
  poster: WagerPoster;
  log: WagerLogger;
  now(): number;
  /** WAGER_OPS_CHAT_ID — solvency alerts route here when set. */
  opsChatId: number | null;
}
