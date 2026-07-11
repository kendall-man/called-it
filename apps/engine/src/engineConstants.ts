/**
 * Engine-process tunables that are not product economics (those live in
 * @calledit/market-engine TUNABLES). One place, no magic numbers.
 */
export const ENGINE = {
  /** Telegram allows ~20 msg/min per group; we run under it with headroom. */
  SEND_RATE_PER_MINUTE: 18,
  /** How often the settler re-checks pending-settlement debounce windows. */
  DEBOUNCE_TICK_MS: 5_000,
  /** How often the ingest supervisor reconciles live sources with fixtures. */
  INGEST_REFRESH_MS: 60_000,
  /** Fixture snapshot sync cadence (PRD: 15-minute cron). */
  FIXTURES_SYNC_MS: 15 * 60_000,
  /** Cadence for the minute-grade cron work (TTL expiry, sweeper, hour jobs). */
  MINUTE_TICK_MS: 60_000,
  /** Keep beta settlement recovery fresher than the worker readiness budget. */
  SETTLEMENT_RECONCILIATION_MS: 15_000,
  /** Prefilter entity dictionary cache TTL. */
  ENTITY_CACHE_TTL_MS: 10 * 60_000,
  /** Start a live source this long before kickoff so lineups are caught. */
  LIVE_LOOKAHEAD_MS: 15 * 60_000,
  /** Replay virtual-clock speed multiplier (PRD: 10–30×). */
  REPLAY_SPEED: 20,
  /** Wait for the proof publication batch to close before the first fetch. */
  PROOF_FIRST_ATTEMPT_DELAY_MS: 60_000,
  PROOF_RETRY_DELAY_MS: 5 * 60_000,
  PROOF_MAX_ATTEMPTS: 5,
  /** Crude per-group daily LLM budget (PRD story 51 degradation guard). */
  MAX_LLM_CALLS_PER_GROUP_PER_DAY: 300,
} as const;

export const DEVNET_EXPLORER_TX_BASE = 'https://explorer.solana.com/tx/';
export const DEVNET_EXPLORER_SUFFIX = '?cluster=devnet';

export function explorerTxUrl(txSig: string): string {
  return `${DEVNET_EXPLORER_TX_BASE}${txSig}${DEVNET_EXPLORER_SUFFIX}`;
}
