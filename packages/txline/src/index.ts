/**
 * @calledit/txline — typed TxLINE client, auth helpers, and the two
 * MatchEventSource implementations (live SSE + replay) that normalize raw
 * TxLINE soccer payloads into @calledit/market-engine MatchEvents.
 */
export {
  TxlineClient,
  TxlineApiError,
  startGuestAuth,
  activateToken,
  type TxlineClientOptions,
  type OpenStreamOptions,
  type StreamKind,
} from './client.js';
export {
  InMemoryCursorStore,
  sleep,
  type CursorStore,
  type EventSourceEndReason,
  type MatchEventSource,
} from './event-source.js';
export { LiveSource, type LiveSourceOptions, type LiveStreamClient } from './live-source.js';
export {
  ReplaySource,
  type ReplaySnapshotClient,
  type ReplaySourceOptions,
  type ReplayStepResult,
} from './replay-source.js';
export {
  normalizeScores,
  buildScoreState,
  mapSoccerStatusToGamePhase,
  coerceEnumName,
  SOCCER_STATUS_TO_PHASE,
  type NormalizeScoresOptions,
} from './normalize-scores.js';
export {
  normalizeOdds,
  combineOddsSnapshot,
  classifyOddsRecord,
  isOddsSuspended,
  isFullMatchPeriod,
  parseTotalsLine,
  buildOddsSuspensionEvent,
  type NormalizeOddsOptions,
  type OddsMarketKind,
  type OddsEventEnrichment,
} from './normalize-odds.js';
export { parseSseStream, type SseFrame } from './sse.js';
export { consoleLogger, silentLogger, type TxlineLogger } from './logging.js';
export { TXLINE_TUNABLES } from './constants.js';
export {
  fixtureRecordSchema,
  lineupDataSchema,
  oddsRecordSchema,
  oddsValidationResponseSchema,
  playerDataSchema,
  playerLineupDataSchema,
  scoresRecordSchema,
  soccerDataSchema,
  soccerFixtureScoreSchema,
  soccerPeriodScoreSchema,
  soccerTotalScoreSchema,
  statValidationResponseSchema,
  tokenResponseSchema,
  type FixtureRecord,
  type LineupData,
  type OddsRecord,
  type OddsValidationResponse,
  type PlayerData,
  type PlayerLineupData,
  type ScoresRecord,
  type SoccerData,
  type SoccerFixtureScore,
  type SoccerPeriodScore,
  type SoccerTotalScore,
  type StatValidationResponse,
} from './schemas.js';
