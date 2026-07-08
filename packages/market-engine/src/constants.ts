/**
 * Every product tunable in one place, per the PRD's "no magic numbers" rule.
 * Values are the PRD v1.1 initial values; tuning is a one-line edit here.
 */
export const TUNABLES = {
  /** Pricing */
  MULTIPLIER_MIN: 1.02,
  MULTIPLIER_MAX: 25,

  /** Agent thresholds */
  CLASSIFIER_NUDGE_THRESHOLD: 0.85,
  CLASSIFIER_REACT_THRESHOLD: 0.5,
  PERSONA_GENERATIONS_PER_MATCH: 20,

  /** Chat hygiene */
  CARD_EDIT_COLLAPSE_MS: 60_000,
  REPRICE_TRIGGER_PP: 5,
  MORNING_SLATE_HOUR_UTC: 9,

  /** Settlement & fairness (re-measure on day-1 spike) */
  SETTLEMENT_DEBOUNCE_MS: 90_000,
  /** Feed delay on devnet service level 1; pending window = delay + debounce. */
  ASSUMED_FEED_DELAY_MS: 60_000,

  /** Claim lifecycle */
  UNCONFIRMED_CLAIM_TTL_MS: 10 * 60_000,
  /** In-play minting closes at this minute for mintable-in-play types. */
  INPLAY_MINT_CUTOFF_MINUTE: 75,
  /** In-play staking hard cutoff (backstop against ×1.02 farming). */
  INPLAY_STAKE_CUTOFF_MINUTE: 85,
} as const;

export const PENDING_TAP_WINDOW_MS =
  TUNABLES.ASSUMED_FEED_DELAY_MS + TUNABLES.SETTLEMENT_DEBOUNCE_MS;
