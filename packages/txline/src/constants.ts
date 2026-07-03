/**
 * TxLINE-integration tunables. Product-level tunables live in
 * @calledit/market-engine constants; everything here is transport-specific.
 */
export const TXLINE_TUNABLES = {
  /**
   * SSE streams emit heartbeat frames between data messages. If nothing —
   * data or heartbeat — arrives for this long, the connection is considered
   * dead and is torn down + reconnected (free tier samples every 60s, so the
   * timeout must comfortably exceed one sampling period).
   */
  HEARTBEAT_TIMEOUT_MS: 90_000,
  /** First reconnect delay; doubled per consecutive failure. */
  RECONNECT_BASE_DELAY_MS: 1_000,
  /** Reconnect backoff ceiling. */
  RECONNECT_MAX_DELAY_MS: 30_000,
  /** How much virtual match time one replay tick advances. */
  REPLAY_TICK_VIRTUAL_MS: 30_000,
  /**
   * Hard stop for a replay's virtual clock: regulation + ET + pens + breaks
   * comfortably fits in 4 hours. Guards against fixtures that never reach a
   * terminal phase in the historical data.
   */
  REPLAY_MAX_VIRTUAL_MS: 4 * 60 * 60_000,
  /** Replay starts this far before kickoff so pre-match odds/lineups stream too. */
  REPLAY_PRE_KICKOFF_LEAD_MS: 10 * 60_000,
  /** How much of an HTTP error body to quote in thrown errors. */
  HTTP_ERROR_BODY_EXCERPT_CHARS: 300,
} as const;

/** TxLINE `Pct` values are percentages ("52.632" ⇒ probability 0.52632). */
export const PCT_TO_PROBABILITY_DIVISOR = 100;

/** Demargined 1X2 probabilities should sum to ~1; outside this band we log. */
export const PROBABILITY_SUM_TOLERANCE = 0.05;
