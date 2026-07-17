/** Mockline server tunables — one place, no magic numbers. */
export const MOCKLINE = {
  /** Default HTTP port; override with MOCKLINE_PORT. */
  DEFAULT_PORT: 8791,
  /** SSE heartbeat cadence — must comfortably beat txline's 90s watchdog. */
  HEARTBEAT_MS: 25_000,
  /** How often the stream pump scans for records whose wall time arrived. */
  PUMP_INTERVAL_MS: 500,
  /** Fixture id of the boot-scheduled, already-finished replay match. */
  REPLAY_FIXTURE_ID: 9001,
  /** First fixture id handed to /mock/schedule matches. */
  LIVE_FIXTURE_ID_BASE: 9101,
  /** Boot-scheduled replay match "kicked off" this long ago. */
  REPLAY_ANCHOR_AGO_MS: 4 * 60 * 60_000,
  /** Default live-match compression: 1 scripted match-minute ≈ 6 wall-seconds. */
  DEFAULT_TIME_SCALE: 10,
  /** Default lead time before a /mock/schedule match kicks off. */
  DEFAULT_KICKOFF_LEAD_MIN: 5,
  /** Values the auth endpoints hand back — mirrored in .env.staging.example. */
  MOCK_GUEST_JWT: 'mock-guest-jwt',
  MOCK_API_TOKEN: 'mock-api-token',
} as const;
