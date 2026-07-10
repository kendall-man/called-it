/**
 * Wager-mode tunables — every money number in one place, all lamports as
 * bigint. Timing tunables that shape market mechanics (PENDING_TAP_WINDOW_MS
 * etc.) are inherited from @calledit/market-engine and NOT duplicated here.
 */

export const WAGER_TUNABLES = {
  /** Stake preset buttons: 0.01 / 0.05 / 0.1 SOL. */
  PRESET_STAKES_LAMPORTS: [10_000_000n, 50_000_000n, 100_000_000n] as const,
  /** Per-user, per-market total stake ceiling (matches the largest preset). */
  PER_MARKET_STAKE_CAP_LAMPORTS: 100_000_000n,
  /** Transfers below this are stored but never credited (dust defense). */
  MIN_DEPOSIT_LAMPORTS: 1_000_000n,
  MIN_WITHDRAWAL_LAMPORTS: 10_000_000n,
  /**
   * Fixed-point scale for the peer-matched ratio: R_milli = round((1−p)/p ×
   * MULT_SCALE), all pot math floor-divided in bigint (see wager/pot.ts).
   */
  MULT_SCALE: 1000,
  /** Treasury headroom for network fees (withdrawal fees are house-absorbed). */
  FEE_BUFFER_LAMPORTS: 50_000_000n,
  DEPOSIT_POLL_MS: 30_000,
  OUTBOX_TICK_MS: 15_000,
  SOLVENCY_POLL_MS: 5 * 60_000,
  SETTLEMENT_SWEEP_MS: 60_000,
  DEPOSIT_COMMITMENT: 'finalized',
} as const;

/**
 * Ledger idempotency keys — single source so a key never drifts between the
 * writer and the crash-recovery sweeper that re-derives it. The stake key is
 * minted server-side by the wager_stake RPC; it is mirrored here so tests can
 * assert parity with migration 0002.
 */
export const WAGER_KEYS = {
  stake: (positionId: string) => `wager:stake:${positionId}`,
  starterGrant: (userId: number) => `wager:starter:${userId}`,
  /** Client-supplied idempotency key for API/concierge stakes (at-least-once). */
  apiStake: (key: string) => `wager:stake:api:${key}`,
  deposit: (txSig: string, ixIndex: number) => `wager:deposit:${txSig}:${ixIndex}`,
  refund: (positionId: string) => `wager:refund:${positionId}`,
  payout: (marketId: string, userId: number) => `wager:payout:${marketId}:${userId}`,
  withdrawal: (withdrawalId: string) => `wager:withdrawal:${withdrawalId}`,
  withdrawalRefund: (withdrawalId: string) => `wager:wrefund:${withdrawalId}`,
} as const;

/**
 * Deposit-watcher cursor stream name, scoped by treasury pubkey so rotating
 * the treasury restarts scanning from genesis instead of resuming a cursor
 * that belongs to the old address.
 */
export function depositCursorStream(treasuryPubkey: string): string {
  return `wager:deposits:${treasuryPubkey}`;
}

/** Advisory-lock names for the singleton crons (rolling-deploy overlap guard). */
export const WAGER_CRON_LOCKS = {
  deposits: 'wager:cron:deposits',
  outbox: 'wager:cron:outbox',
} as const;

/** Solvency-breaker reasons are prefixed so auto-recovery never clears a manual pause. */
export const SOLVENCY_PAUSE_REASON_PREFIX = 'solvency:';
