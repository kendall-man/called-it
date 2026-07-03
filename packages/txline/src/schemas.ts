import { z } from 'zod';

/**
 * Zod schemas for the TxLINE off-chain API (OpenAPI v1.5.2 at
 * https://txline.txodds.com/docs/docs.yaml). Field names/casing follow the
 * OBSERVED wire, not the spec: the spec claims Scores records are camelCase,
 * but live devnet sends PascalCase on every endpoint (fixtures, odds, AND
 * scores — audit-verified against /api/scores/snapshot). Scores schemas
 * canonicalize on the wire names and fold the spec's camelCase spellings in
 * as aliases, in case the SSE stream ever serializes per spec. Everything
 * parses defensively:
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

/**
 * Folds alias key spellings onto their canonical names before validation.
 * Scores schemas canonicalize on the OBSERVED wire names and accept the
 * spec's spellings as aliases; an alias is only applied when the canonical
 * key is absent, so records already in canonical form pass through untouched.
 */
const foldKeyAliases =
  (aliasToCanonical: Readonly<Record<string, string>>) =>
  (raw: unknown): unknown => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const record = raw as Record<string, unknown>;
    let folded: Record<string, unknown> | null = null;
    for (const [alias, canonical] of Object.entries(aliasToCanonical)) {
      if (alias in record && !(canonical in record)) {
        folded ??= { ...record };
        folded[canonical] = record[alias];
        delete folded[alias];
      }
    }
    return folded ?? record;
  };

/**
 * Array whose malformed entries are skipped instead of failing the parent —
 * e.g. one anonymous substitute in a lineup must never drop the scores
 * record (and the goal/status data) it rides on.
 */
const skippingArray = <T extends z.ZodTypeAny>(schema: T) =>
  z.array(z.unknown()).transform((entries): Array<z.output<T>> =>
    entries.flatMap((entry) => {
      const parsed = schema.safeParse(entry);
      return parsed.success ? [parsed.data as z.output<T>] : [];
    }),
  );

// ── Soccer score fragments ────────────────────────────────────────────────

// The nested scores schemas are annotated with explicit output interfaces —
// zod's inferred effect-chain types exceed tsc's declaration-emit size limit,
// and the interfaces double as readable wire documentation.

/**
 * Period tallies arrive SPARSE on the wire: zero-valued counters are simply
 * omitted (observed live: `{"Goals": 1, "Corners": 2}` with no card fields).
 * Fold absent/null counters to 0 so score arithmetic stays plain number math.
 */
const sparseTally = z.number().nullish().transform((value): number => value ?? 0);

/** Per-period team tallies (spec: SoccerScore), zero-defaulted. */
export interface SoccerPeriodScore {
  Goals: number;
  YellowCards: number;
  RedCards: number;
  Corners: number;
  [key: string]: unknown;
}

export const soccerPeriodScoreSchema: z.ZodType<SoccerPeriodScore, z.ZodTypeDef, unknown> = z
  .object({
    Goals: sparseTally,
    YellowCards: sparseTally,
    RedCards: sparseTally,
    Corners: sparseTally,
  })
  .passthrough();

/** All periods optional — the feed adds them as the match progresses (spec: SoccerTotalScore). */
export interface SoccerTotalScore {
  H1?: SoccerPeriodScore | undefined;
  HT?: SoccerPeriodScore | undefined;
  H2?: SoccerPeriodScore | undefined;
  ET1?: SoccerPeriodScore | undefined;
  ET2?: SoccerPeriodScore | undefined;
  PE?: SoccerPeriodScore | undefined;
  ETTotal?: SoccerPeriodScore | undefined;
  Total?: SoccerPeriodScore | undefined;
  [key: string]: unknown;
}

export const soccerTotalScoreSchema: z.ZodType<SoccerTotalScore, z.ZodTypeDef, unknown> = z
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

/**
 * spec: SoccerFixtureScore. Both sides lenient: a one-sided score object
 * early in coverage must not drop the whole record.
 */
export interface SoccerFixtureScore {
  Participant1?: SoccerTotalScore | undefined;
  Participant2?: SoccerTotalScore | undefined;
  [key: string]: unknown;
}

export const soccerFixtureScoreSchema: z.ZodType<SoccerFixtureScore, z.ZodTypeDef, unknown> = z
  .object({
    Participant1: lenient(soccerTotalScoreSchema),
    Participant2: lenient(soccerTotalScoreSchema),
  })
  .passthrough();

/** Match clock (observed live: `{"Running": true, "Seconds": 5106}`). */
export interface MatchClock {
  Running?: boolean | undefined;
  Seconds?: number | undefined;
  [key: string]: unknown;
}

export const clockSchema: z.ZodType<MatchClock, z.ZodTypeDef, unknown> = z
  .object({
    Running: lenient(z.boolean()),
    Seconds: lenient(z.number()),
  })
  .passthrough();

/**
 * spec: SoccerData — the event detail attached to a scores record.
 * GoalType / enum-ish fields are `unknown` because the spec models them as a
 * oneOf of empty named objects; serialization may be a bare string ("OwnGoal")
 * or a wrapper object — `coerceEnumName` in normalize-scores handles both.
 */
export interface SoccerEventDetail {
  Action?: string | undefined;
  Clock?: MatchClock | undefined;
  Corner?: boolean | undefined;
  Goal?: boolean | undefined;
  GoalType?: unknown;
  Minutes?: number | undefined;
  Outcome?: string | undefined;
  Participant?: number | undefined;
  Penalty?: boolean | undefined;
  PlayerId?: number | undefined;
  PlayerInId?: number | undefined;
  PlayerOutId?: number | undefined;
  StatusId?: number | undefined;
  Type?: string | undefined;
  RedCard?: boolean | undefined;
  YellowCard?: boolean | undefined;
  VAR?: boolean | undefined;
  [key: string]: unknown;
}

const soccerEventDetailShape = {
  Action: lenient(z.string()),
  Clock: lenient(clockSchema),
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
};
const soccerEventDetailSchema: z.ZodType<SoccerEventDetail, z.ZodTypeDef, unknown> = z
  .object(soccerEventDetailShape)
  .passthrough();

/**
 * Amend records wrap the corrected/original payloads in a New/Previous
 * envelope (observed live: `Data = {Action, New: {…}, Previous: {…}}`);
 * discard records may carry a completely EMPTY Data envelope — the only link
 * to the discarded event is the record-level Id.
 */
export interface SoccerData extends SoccerEventDetail {
  New?: SoccerEventDetail | undefined;
  Previous?: SoccerEventDetail | undefined;
}

export const soccerDataSchema: z.ZodType<SoccerData, z.ZodTypeDef, unknown> = z
  .object({
    ...soccerEventDetailShape,
    New: lenient(soccerEventDetailSchema),
    Previous: lenient(soccerEventDetailSchema),
  })
  .passthrough();

// ── Lineups ───────────────────────────────────────────────────────────────
//
// Lineup records have NOT been observed on the wire yet (they publish ~1h
// before kickoff and the audited snapshots predate that). Given every
// observed scores field is PascalCase despite a camelCase spec, both
// spellings are accepted here until a live capture pins the real one.

/** spec: PlayerData (normativeId is the cross-feed player key we carry). */
export interface PlayerData {
  normativeId: number;
  preferredName: string;
  team?: string | undefined;
  [key: string]: unknown;
}

export const playerDataSchema: z.ZodType<PlayerData, z.ZodTypeDef, unknown> = z.preprocess(
  foldKeyAliases({ NormativeId: 'normativeId', PreferredName: 'preferredName', Team: 'team' }),
  z
    .object({
      normativeId: z.number(),
      preferredName: z.string(),
      team: lenient(z.string()),
    })
    .passthrough(),
);

/** spec: PlayerLineupData. */
export interface PlayerLineupData {
  starter?: boolean | undefined;
  player: PlayerData;
  [key: string]: unknown;
}

export const playerLineupDataSchema: z.ZodType<PlayerLineupData, z.ZodTypeDef, unknown> =
  z.preprocess(
    foldKeyAliases({ Starter: 'starter', Player: 'player' }),
    z
      .object({
        starter: lenient(z.boolean()),
        player: playerDataSchema,
      })
      .passthrough(),
  );

/**
 * spec: LineupData — team-level entry wrapping the player list. Malformed
 * player entries are skipped individually, never fatal to the lineup.
 */
export interface LineupData {
  normativeId: number;
  preferredName: string;
  lineups?: PlayerLineupData[] | undefined;
  [key: string]: unknown;
}

export const lineupDataSchema: z.ZodType<LineupData, z.ZodTypeDef, unknown> = z.preprocess(
  foldKeyAliases({
    NormativeId: 'normativeId',
    PreferredName: 'preferredName',
    Lineups: 'lineups',
  }),
  z
    .object({
      normativeId: z.number(),
      preferredName: z.string(),
      lineups: lenient(skippingArray(playerLineupDataSchema)),
    })
    .passthrough(),
);

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
 * Spec (camelCase, sport-suffixed) spellings folded onto the observed
 * PascalCase wire names. Audit-verified on /api/scores/snapshot: EVERY live
 * record is PascalCase, and the spec's sport-suffixed names
 * (scoreSoccer/dataSoccer/statusSoccerId/…) do not exist on the wire — the
 * sport arrives as a top-level `Type: "Soccer"` instead. Accepting the spec
 * spellings costs one key fold and keeps ingestion alive if the SSE stream
 * ever serializes per spec.
 */
const SCORES_SPEC_KEY_TO_WIRE: Readonly<Record<string, string>> = {
  fixtureId: 'FixtureId',
  seq: 'Seq',
  ts: 'Ts',
  action: 'Action',
  id: 'Id',
  gameState: 'GameState',
  startTime: 'StartTime',
  competitionId: 'CompetitionId',
  countryId: 'CountryId',
  sportId: 'SportId',
  connectionId: 'ConnectionId',
  fixtureGroupId: 'FixtureGroupId',
  isTeam: 'IsTeam',
  participant1Id: 'Participant1Id',
  participant2Id: 'Participant2Id',
  participant1IsHome: 'Participant1IsHome',
  participant: 'Participant',
  confirmed: 'Confirmed',
  coverageSecondaryData: 'CoverageSecondaryData',
  coverageType: 'CoverageType',
  statusSoccerId: 'StatusId',
  scoreSoccer: 'Score',
  dataSoccer: 'Data',
  stats: 'Stats',
  lineups: 'Lineups',
  possibleEventSoccer: 'PossibleEvent',
  parti1StateSoccer: 'Parti1State',
  parti2StateSoccer: 'Parti2State',
  type: 'Type',
  clock: 'Clock',
  possession: 'Possession',
  possessionType: 'PossessionType',
};

/**
 * spec: Scores; field names per the OBSERVED wire (PascalCase). Required
 * fields are the settlement-load-bearing subset (audit-verified): FixtureId,
 * Seq, Ts, Action. `StatusId` stays `unknown` — a bare NUMBER on the live
 * wire, but a oneOf of empty named objects (NS/H1/…/TXCS) per spec whose
 * encoding could also be a string or wrapper; normalize-scores coerces all
 * of them.
 */
const scoresRecordObjectSchema = z
  .object({
    FixtureId: z.number(),
    Seq: z.number(),
    Ts: z.number(),
    Action: z.string(),
    Id: lenient(z.number()),
    GameState: lenient(z.string()),
    StartTime: lenient(z.number()),
    CompetitionId: lenient(z.number()),
    CountryId: lenient(z.number()),
    SportId: lenient(z.number()),
    ConnectionId: lenient(z.number()),
    FixtureGroupId: lenient(z.number()),
    IsTeam: lenient(z.boolean()),
    Participant1Id: lenient(z.number()),
    Participant2Id: lenient(z.number()),
    Participant1IsHome: lenient(z.boolean()),
    /** Which side the Possession indicator refers to — NOT event attribution. */
    Participant: lenient(z.number()),
    /** Sent AFFIRMATIVELY (`true`) on confirmed records; often absent. */
    Confirmed: lenient(z.boolean()),
    /**
     * Static fixture attribute — "covered from a secondary source"
     * (CoverageType TV/Stream/Venue). Present on every record of covered
     * fixtures from Seq 0; NOT a coverage-loss warning.
     */
    CoverageSecondaryData: lenient(z.boolean()),
    CoverageType: lenient(z.string()),
    /** Sport discriminator, e.g. "Soccer" (replaces the spec's sport-suffixed field names). */
    Type: lenient(z.string()),
    StatusId: z.unknown().optional(),
    Clock: lenient(clockSchema),
    Possession: lenient(z.number()),
    PossessionType: lenient(z.string()),
    Score: lenient(soccerFixtureScoreSchema),
    Data: lenient(soccerDataSchema),
    Stats: lenient(z.record(z.number())),
    /** Malformed team entries are skipped individually, never fatal to the record. */
    Lineups: lenient(skippingArray(lineupDataSchema)),
    PossibleEvent: lenient(soccerPossibleNeutralEventSchema),
    Parti1State: lenient(soccerPartiStateSchema),
    Parti2State: lenient(soccerPartiStateSchema),
  })
  .passthrough();

/**
 * Parsed scores record: the validated wire shape plus camelCase mirrors of
 * `seq`/`ts`/`startTime` — the stable projection consumers key replay dedup
 * and kickoff probing on.
 */
export type ScoresRecord = z.infer<typeof scoresRecordObjectSchema> & {
  seq: number;
  ts: number;
  startTime: number | undefined;
};

/**
 * Full scores-record parser: folds spec-spelling aliases onto the wire
 * names, validates, then adds the camelCase mirrors. (Explicitly annotated —
 * the inferred effects chain exceeds tsc's declaration-emit size limit.)
 */
export const scoresRecordSchema: z.ZodType<ScoresRecord, z.ZodTypeDef, unknown> = z
  .preprocess(foldKeyAliases(SCORES_SPEC_KEY_TO_WIRE), scoresRecordObjectSchema)
  .transform((record) => ({
    ...record,
    seq: record.Seq,
    ts: record.Ts,
    startTime: record.StartTime,
  }));

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
