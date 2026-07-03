import { z } from 'zod';

/**
 * Zod schemas for the TxLINE off-chain API (OpenAPI v1.5.2 at
 * https://txline.txodds.com/docs/docs.yaml). Field names/casing follow the
 * spec exactly: Scores/fixture records are camelCase, Odds records are
 * PascalCase. Everything parses defensively:
 *   - `.passthrough()` keeps unknown fields instead of stripping them;
 *   - only load-bearing fields are required, the rest are optional so minor
 *     spec drift degrades gracefully instead of dropping the whole record.
 */

// ── Soccer score fragments ────────────────────────────────────────────────

/** Per-period team tallies (spec: SoccerScore). */
export const soccerPeriodScoreSchema = z
  .object({
    Goals: z.number(),
    YellowCards: z.number(),
    RedCards: z.number(),
    Corners: z.number(),
  })
  .passthrough();
export type SoccerPeriodScore = z.infer<typeof soccerPeriodScoreSchema>;

/** All periods optional — the feed adds them as the match progresses (spec: SoccerTotalScore). */
export const soccerTotalScoreSchema = z
  .object({
    H1: soccerPeriodScoreSchema.optional(),
    HT: soccerPeriodScoreSchema.optional(),
    H2: soccerPeriodScoreSchema.optional(),
    ET1: soccerPeriodScoreSchema.optional(),
    ET2: soccerPeriodScoreSchema.optional(),
    PE: soccerPeriodScoreSchema.optional(),
    ETTotal: soccerPeriodScoreSchema.optional(),
    Total: soccerPeriodScoreSchema.optional(),
  })
  .passthrough();
export type SoccerTotalScore = z.infer<typeof soccerTotalScoreSchema>;

/** spec: SoccerFixtureScore. */
export const soccerFixtureScoreSchema = z
  .object({
    Participant1: soccerTotalScoreSchema,
    Participant2: soccerTotalScoreSchema,
  })
  .passthrough();
export type SoccerFixtureScore = z.infer<typeof soccerFixtureScoreSchema>;

/**
 * spec: SoccerData — the event detail attached to a scores record.
 * GoalType / enum-ish fields are `unknown` because the spec models them as a
 * oneOf of empty named objects; serialization may be a bare string ("OwnGoal")
 * or a wrapper object — `coerceEnumName` in normalize-scores handles both.
 */
export const soccerDataSchema = z
  .object({
    Action: z.string().optional(),
    Corner: z.boolean().optional(),
    Goal: z.boolean().optional(),
    GoalType: z.unknown().optional(),
    Minutes: z.number().optional(),
    Outcome: z.string().optional(),
    Participant: z.number().optional(),
    Penalty: z.boolean().optional(),
    PlayerId: z.number().optional(),
    PlayerInId: z.number().optional(),
    PlayerOutId: z.number().optional(),
    StatusId: z.number().optional(),
    Type: z.string().optional(),
    RedCard: z.boolean().optional(),
    YellowCard: z.boolean().optional(),
    VAR: z.boolean().optional(),
  })
  .passthrough();
export type SoccerData = z.infer<typeof soccerDataSchema>;

// ── Lineups ───────────────────────────────────────────────────────────────

/** spec: PlayerData (normativeId is the cross-feed player key we carry). */
export const playerDataSchema = z
  .object({
    normativeId: z.number(),
    preferredName: z.string(),
    team: z.string().optional(),
  })
  .passthrough();
export type PlayerData = z.infer<typeof playerDataSchema>;

/** spec: PlayerLineupData. */
export const playerLineupDataSchema = z
  .object({
    starter: z.boolean().optional(),
    player: playerDataSchema,
  })
  .passthrough();
export type PlayerLineupData = z.infer<typeof playerLineupDataSchema>;

/** spec: LineupData — team-level entry wrapping the player list. */
export const lineupDataSchema = z
  .object({
    normativeId: z.number(),
    preferredName: z.string(),
    lineups: z.array(playerLineupDataSchema).optional(),
  })
  .passthrough();
export type LineupData = z.infer<typeof lineupDataSchema>;

// ── Possible-event flags (freeze triggers) ────────────────────────────────

export const soccerPossibleNeutralEventSchema = z
  .object({
    RedCard: z.boolean().optional(),
    YellowCard: z.boolean().optional(),
    VAR: z.boolean().optional(),
  })
  .passthrough();

export const soccerPartiStateSchema = z
  .object({
    PossibleEvent: z
      .object({
        Goal: z.boolean().optional(),
        Penalty: z.boolean().optional(),
        Corner: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

// ── Scores record ─────────────────────────────────────────────────────────

/**
 * spec: Scores. Required fields here are the settlement-load-bearing subset
 * (audit-verified): fixtureId, seq, ts, action. `statusSoccerId` stays
 * `unknown` — the spec models it as a oneOf of empty named objects
 * (NS/H1/…/TXCS) whose wire encoding must be coerced, see normalize-scores.
 */
export const scoresRecordSchema = z
  .object({
    fixtureId: z.number(),
    seq: z.number(),
    ts: z.number(),
    action: z.string(),
    id: z.number().optional(),
    gameState: z.string().optional(),
    startTime: z.number().optional(),
    competitionId: z.number().optional(),
    countryId: z.number().optional(),
    sportId: z.number().optional(),
    connectionId: z.number().optional(),
    fixtureGroupId: z.number().optional(),
    isTeam: z.boolean().optional(),
    participant1Id: z.number().optional(),
    participant2Id: z.number().optional(),
    participant1IsHome: z.boolean().optional(),
    participant: z.number().optional(),
    confirmed: z.boolean().optional(),
    coverageSecondaryData: z.boolean().optional(),
    coverageType: z.string().optional(),
    statusSoccerId: z.unknown().optional(),
    scoreSoccer: soccerFixtureScoreSchema.optional(),
    dataSoccer: soccerDataSchema.optional(),
    stats: z.record(z.number()).optional(),
    lineups: z.array(lineupDataSchema).optional(),
    possibleEventSoccer: soccerPossibleNeutralEventSchema.optional(),
    parti1StateSoccer: soccerPartiStateSchema.optional(),
    parti2StateSoccer: soccerPartiStateSchema.optional(),
  })
  .passthrough();
export type ScoresRecord = z.infer<typeof scoresRecordSchema>;

// ── Odds record ───────────────────────────────────────────────────────────

/**
 * spec: OddsPayload (PascalCase!). `Pct` entries are demargined percentages
 * formatted to 3 decimals, or the literal "NA" (quarter-handicap lines).
 */
export const oddsRecordSchema = z
  .object({
    FixtureId: z.number(),
    MessageId: z.string(),
    Ts: z.number(),
    SuperOddsType: z.string(),
    Bookmaker: z.string().optional(),
    BookmakerId: z.number().optional(),
    GameState: z.string().optional(),
    InRunning: z.boolean().optional(),
    MarketParameters: z.string().optional(),
    MarketPeriod: z.string().optional(),
    PriceNames: z.array(z.string()).optional(),
    Prices: z.array(z.number()).optional(),
    Pct: z.array(z.string()).optional(),
  })
  .passthrough();
export type OddsRecord = z.infer<typeof oddsRecordSchema>;

// ── Fixtures ──────────────────────────────────────────────────────────────

/** spec: Fixture (PascalCase). */
export const fixtureRecordSchema = z
  .object({
    FixtureId: z.number(),
    StartTime: z.number(),
    Participant1Id: z.number(),
    Participant1: z.string(),
    Participant2Id: z.number(),
    Participant2: z.string(),
    Ts: z.number().optional(),
    Competition: z.string().optional(),
    CompetitionId: z.number().optional(),
    FixtureGroupId: z.number().optional(),
    Participant1IsHome: z.boolean().optional(),
  })
  .passthrough();
export type FixtureRecord = z.infer<typeof fixtureRecordSchema>;

// ── Validation / auth responses ───────────────────────────────────────────

/**
 * Proof payloads are stored opaquely and forwarded to on-chain validation, so
 * we pin only the envelope fields we rely on and pass the rest through.
 */
export const statValidationResponseSchema = z
  .object({
    ts: z.number().optional(),
    statToProve: z.unknown().optional(),
    statsToProve: z.unknown().optional(),
    eventStatRoot: z.unknown().optional(),
    summary: z.unknown().optional(),
    statProof: z.unknown().optional(),
    statProofs: z.unknown().optional(),
    subTreeProof: z.unknown().optional(),
    mainTreeProof: z.unknown().optional(),
  })
  .passthrough();
export type StatValidationResponse = z.infer<typeof statValidationResponseSchema>;

export const oddsValidationResponseSchema = z
  .object({
    odds: z.unknown().optional(),
    summary: z.unknown().optional(),
    subTreeProof: z.unknown().optional(),
    mainTreeProof: z.unknown().optional(),
  })
  .passthrough();
export type OddsValidationResponse = z.infer<typeof oddsValidationResponseSchema>;

/** spec: TokenResponse from POST /auth/guest/start. */
export const tokenResponseSchema = z.object({ token: z.string() }).passthrough();
