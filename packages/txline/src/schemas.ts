import { z } from 'zod';

/**
 * Zod schemas for the TxLINE off-chain API (OpenAPI v1.5.2 at
 * https://txline.txodds.com/docs/docs.yaml). Field names/casing follow the
 * spec exactly: Scores/fixture records are camelCase, Odds records are
 * PascalCase. Everything parses defensively:
 *   - `.passthrough()` keeps unknown fields instead of stripping them;
 *   - only load-bearing fields are required, the rest are lenient so minor
 *     spec drift degrades gracefully instead of dropping the whole record.
 */

/**
 * Optional wire field. Devnet sends explicit `null` where the spec marks
 * fields optional (observed live on /api/odds/snapshot: GameState and
 * MarketParameters were null), and zod's `.optional()` rejects explicit null.
 * Accept null on the wire but fold it to undefined so downstream code keeps
 * the plain `T | undefined` view.
 */
const lenient = <T extends z.ZodTypeAny>(schema: T) =>
  schema.nullish().transform((value): z.output<T> | undefined => value ?? undefined);

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
    H1: lenient(soccerPeriodScoreSchema),
    HT: lenient(soccerPeriodScoreSchema),
    H2: lenient(soccerPeriodScoreSchema),
    ET1: lenient(soccerPeriodScoreSchema),
    ET2: lenient(soccerPeriodScoreSchema),
    PE: lenient(soccerPeriodScoreSchema),
    ETTotal: lenient(soccerPeriodScoreSchema),
    Total: lenient(soccerPeriodScoreSchema),
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
    Action: lenient(z.string()),
    Corner: lenient(z.boolean()),
    Goal: lenient(z.boolean()),
    GoalType: z.unknown().optional(),
    Minutes: lenient(z.number()),
    Outcome: lenient(z.string()),
    Participant: lenient(z.number()),
    Penalty: lenient(z.boolean()),
    PlayerId: lenient(z.number()),
    PlayerInId: lenient(z.number()),
    PlayerOutId: lenient(z.number()),
    StatusId: lenient(z.number()),
    Type: lenient(z.string()),
    RedCard: lenient(z.boolean()),
    YellowCard: lenient(z.boolean()),
    VAR: lenient(z.boolean()),
  })
  .passthrough();
export type SoccerData = z.infer<typeof soccerDataSchema>;

// ── Lineups ───────────────────────────────────────────────────────────────

/** spec: PlayerData (normativeId is the cross-feed player key we carry). */
export const playerDataSchema = z
  .object({
    normativeId: z.number(),
    preferredName: z.string(),
    team: lenient(z.string()),
  })
  .passthrough();
export type PlayerData = z.infer<typeof playerDataSchema>;

/** spec: PlayerLineupData. */
export const playerLineupDataSchema = z
  .object({
    starter: lenient(z.boolean()),
    player: playerDataSchema,
  })
  .passthrough();
export type PlayerLineupData = z.infer<typeof playerLineupDataSchema>;

/** spec: LineupData — team-level entry wrapping the player list. */
export const lineupDataSchema = z
  .object({
    normativeId: z.number(),
    preferredName: z.string(),
    lineups: lenient(z.array(playerLineupDataSchema)),
  })
  .passthrough();
export type LineupData = z.infer<typeof lineupDataSchema>;

// ── Possible-event flags (freeze triggers) ────────────────────────────────

export const soccerPossibleNeutralEventSchema = z
  .object({
    RedCard: lenient(z.boolean()),
    YellowCard: lenient(z.boolean()),
    VAR: lenient(z.boolean()),
  })
  .passthrough();

export const soccerPartiStateSchema = z
  .object({
    PossibleEvent: lenient(
      z
        .object({
          Goal: lenient(z.boolean()),
          Penalty: lenient(z.boolean()),
          Corner: lenient(z.boolean()),
        })
        .passthrough(),
    ),
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
    id: lenient(z.number()),
    gameState: lenient(z.string()),
    startTime: lenient(z.number()),
    competitionId: lenient(z.number()),
    countryId: lenient(z.number()),
    sportId: lenient(z.number()),
    connectionId: lenient(z.number()),
    fixtureGroupId: lenient(z.number()),
    isTeam: lenient(z.boolean()),
    participant1Id: lenient(z.number()),
    participant2Id: lenient(z.number()),
    participant1IsHome: lenient(z.boolean()),
    participant: lenient(z.number()),
    confirmed: lenient(z.boolean()),
    coverageSecondaryData: lenient(z.boolean()),
    coverageType: lenient(z.string()),
    statusSoccerId: z.unknown().optional(),
    scoreSoccer: lenient(soccerFixtureScoreSchema),
    dataSoccer: lenient(soccerDataSchema),
    stats: lenient(z.record(z.number())),
    lineups: lenient(z.array(lineupDataSchema)),
    possibleEventSoccer: lenient(soccerPossibleNeutralEventSchema),
    parti1StateSoccer: lenient(soccerPartiStateSchema),
    parti2StateSoccer: lenient(soccerPartiStateSchema),
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
    Bookmaker: lenient(z.string()),
    BookmakerId: lenient(z.number()),
    GameState: lenient(z.string()),
    InRunning: lenient(z.boolean()),
    MarketParameters: lenient(z.string()),
    MarketPeriod: lenient(z.string()),
    PriceNames: lenient(z.array(z.string())),
    Prices: lenient(z.array(z.number())),
    Pct: lenient(z.array(z.string())),
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
    Ts: lenient(z.number()),
    Competition: lenient(z.string()),
    CompetitionId: lenient(z.number()),
    FixtureGroupId: lenient(z.number()),
    Participant1IsHome: lenient(z.boolean()),
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
    ts: lenient(z.number()),
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
