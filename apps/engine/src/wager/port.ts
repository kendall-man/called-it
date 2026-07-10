import type {
  WagerCurrency,
  WagerDb,
  WagerMarketRow,
  WagerPositionSide,
  WagerSettlementOutcome,
} from './port-db.js';

export type * from './port-db.js';

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
  /** Exact stake in lamports — the caller resolves presets to lamports. */
  lamports: bigint;
  inPlay: boolean;
  nowMs: number;
  /** At-least-once dedup key (concierge/API); omitted on button taps. */
  idempotencyKey?: string;
}

export interface WagerModule {
  /** Always 'sol' now — every market is a SOL market. Stamped atomically at mint. */
  currencyForMint(groupId: number): Promise<WagerCurrency>;
  /** The stake path shared by buttons and the API; reply is the answer text. */
  handleStakeTap(args: WagerStakeTapArgs): Promise<{ reply: string; placed: boolean }>;
  /** Idempotent money movement for a settled/voided sol market. */
  applySettlement(marketId: string): Promise<void>;
  /** Chat receipt line (SOL amounts are chat-only; public_receipts untouched). */
  settlementPayoutsLine(marketId: string, outcome: WagerSettlementOutcome): Promise<string>;
  cardFooter(): string;
  presetLabels(): [string, string, string];
  /** Preset button index → lamports (out-of-range → null). */
  presetLamports(index: number): bigint | null;
  /** User-global SOL balance (lamports) + linked wallet, for the API wallet route. */
  walletSummary(userId: number): Promise<{ balanceLamports: bigint; pubkey: string | null }>;
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
