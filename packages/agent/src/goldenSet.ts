/**
 * Golden fixture set — ≥50 real-shaped banter phrasings (slang, typos,
 * non-claims) with the RawClaimParse each should produce (or null).
 *
 * Used three ways:
 *  1. prefilter matrix — every claim must pass; every 'prefilter_kill'
 *     non-claim must die before a model is ever called.
 *  2. mock-parser harness in CI — parseClaim plumbing is exercised with a
 *     scripted client + these executors; asserts compiled-shape equality.
 *  3. live harness (AGENT_LIVE=1 only) — the same expectations against the
 *     real models; gates prompt changes.
 *
 * All fixture ids, kickoff times and rosters here are synthetic — no feed
 * data is recorded anywhere in this repo.
 */

import type { CompileContext, RawClaimParse } from '@calledit/market-engine';
import type { EntityHints } from './classify.js';
import type {
  FixtureSearchResult,
  MarketMenuEntry,
  ParseToolExecutors,
  PlayerResolveResult,
} from './parse.js';
import { CLAIM_TYPE_VALUES } from './claim-taxonomy.js';
import { normalizeForMatch } from './prefilter.js';

// ── Synthetic knockout slate ──────────────────────────────────────────────

/** A stable "now" for the golden world: all kickoffs are relative to this. */
export const GOLDEN_NOW_MS = 1_782_000_000_000;

const HOUR_MS = 60 * 60 * 1000;

export interface GoldenFixtureInfo extends FixtureSearchResult {
  aliases: readonly string[];
}

export const goldenFixtures: readonly GoldenFixtureInfo[] = [
  {
    fixtureId: 9101,
    p1Name: 'France',
    p2Name: 'Brazil',
    kickoffMs: GOLDEN_NOW_MS + 3 * HOUR_MS,
    phase: 'NS',
    aliases: ['france', 'les bleus', 'brazil', 'selecao'],
  },
  {
    fixtureId: 9102,
    p1Name: 'England',
    p2Name: 'Argentina',
    kickoffMs: GOLDEN_NOW_MS + 6 * HOUR_MS,
    phase: 'NS',
    aliases: ['england', 'ingerland', 'three lions', 'argentina', 'albiceleste'],
  },
  {
    fixtureId: 9103,
    p1Name: 'Spain',
    p2Name: 'Portugal',
    kickoffMs: GOLDEN_NOW_MS + 27 * HOUR_MS,
    phase: 'NS',
    aliases: ['spain', 'la roja', 'portugal'],
  },
  {
    fixtureId: 9104,
    p1Name: 'Germany',
    p2Name: 'Netherlands',
    kickoffMs: GOLDEN_NOW_MS + 30 * HOUR_MS,
    phase: 'NS',
    aliases: ['germany', 'die mannschaft', 'netherlands', 'holland', 'oranje'],
  },
] as const;

export interface GoldenPlayerInfo extends PlayerResolveResult {
  fixtureId: number;
  aliases: readonly string[];
}

export const goldenPlayers: readonly GoldenPlayerInfo[] = [
  { normativeId: 501, name: 'Kylian Mbappé', participant: 1, fixtureId: 9101, aliases: ['mbappe', 'mbape', 'kylian'] },
  { normativeId: 502, name: 'Vinícius Júnior', participant: 2, fixtureId: 9101, aliases: ['vinicius', 'vini'] },
  { normativeId: 503, name: 'Harry Kane', participant: 1, fixtureId: 9102, aliases: ['kane'] },
  { normativeId: 504, name: 'Jude Bellingham', participant: 1, fixtureId: 9102, aliases: ['bellingham', 'jude'] },
  { normativeId: 505, name: 'Lionel Messi', participant: 2, fixtureId: 9102, aliases: ['messi', 'leo'] },
  { normativeId: 506, name: 'Julián Álvarez', participant: 2, fixtureId: 9102, aliases: ['alvarez', 'julian'] },
  { normativeId: 507, name: 'Lamine Yamal', participant: 1, fixtureId: 9103, aliases: ['yamal', 'lamine'] },
  { normativeId: 508, name: 'Cristiano Ronaldo', participant: 2, fixtureId: 9103, aliases: ['ronaldo', 'cr7 ronaldo'] },
  { normativeId: 509, name: 'Jamal Musiala', participant: 1, fixtureId: 9104, aliases: ['musiala'] },
  { normativeId: 510, name: 'Memphis Depay', participant: 2, fixtureId: 9104, aliases: ['memphis', 'depay'] },
] as const;

/** The dictionary the engine would build daily from fixtures/players. */
export const goldenEntities: EntityHints = {
  teamNames: goldenFixtures.flatMap((f) => [f.p1Name, f.p2Name, ...f.aliases]),
  playerNames: goldenPlayers.flatMap((p) => [p.name, ...p.aliases]),
};

/** Build the CompileContext the engine would pass for a given fixture. */
export function makeGoldenContext(fixtureId: number): CompileContext {
  const fixture = goldenFixtures.find((f) => f.fixtureId === fixtureId) ?? null;
  return {
    fixture: fixture
      ? {
          fixtureId: fixture.fixtureId,
          p1Name: fixture.p1Name,
          p2Name: fixture.p2Name,
          kickoffMs: fixture.kickoffMs,
          phase: fixture.phase,
          minute: null,
          score: { p1Goals: 0, p2Goals: 0 },
          lastSeq: 0,
          coverageUnreliable: false,
        }
      : null,
    knownPlayers: goldenPlayers
      .filter((p) => p.fixtureId === fixtureId)
      .map(({ normativeId, name, participant }) => ({ normativeId, name, participant })),
    nowMs: GOLDEN_NOW_MS,
  };
}

/** Grounded executors over the synthetic slate — used by mock & live tests. */
export function makeGoldenExecutors(): ParseToolExecutors {
  return {
    async searchFixtures(query: string): Promise<FixtureSearchResult[]> {
      const q = normalizeForMatch(query);
      return goldenFixtures
        .filter(
          (f) =>
            normalizeForMatch(f.p1Name).includes(q) ||
            normalizeForMatch(f.p2Name).includes(q) ||
            f.aliases.some((a) => normalizeForMatch(a).includes(q) || q.includes(normalizeForMatch(a))),
        )
        .map(({ aliases: _aliases, ...fixture }) => fixture);
    },
    async resolvePlayer(name: string): Promise<PlayerResolveResult[]> {
      const q = normalizeForMatch(name);
      return goldenPlayers
        .filter(
          (p) =>
            normalizeForMatch(p.name).includes(q) ||
            p.aliases.some((a) => q.includes(a) || a.includes(q)),
        )
        .map(({ normativeId, name: canonical, participant }) => ({
          normativeId,
          name: canonical,
          participant,
        }));
    },
    async getMarketMenu(fixtureId: number): Promise<MarketMenuEntry[]> {
      const known = goldenFixtures.some((f) => f.fixtureId === fixtureId);
      return CLAIM_TYPE_VALUES.map((claimType) => ({
        claimType,
        mintable: known,
        ...(known ? {} : { reason: 'unknown fixture' }),
      }));
    },
  };
}

// ── The golden set ────────────────────────────────────────────────────────

export type GoldenTag =
  | 'prefilter_kill'
  | 'needs_classifier'
  | 'slang'
  | 'typo'
  | 'monetary_forfeit'
  | 'in_play';

export interface GoldenFixture {
  text: string;
  expected: RawClaimParse | null;
  /** Which chat/fixture context the message lives in (default 9101). */
  contextFixtureId?: number;
  tags?: readonly GoldenTag[];
}

const DEFAULT_CONTEXT_FIXTURE = 9101;

function parseOf(partial: Partial<RawClaimParse>): RawClaimParse {
  return {
    claimType: null,
    fixtureId: DEFAULT_CONTEXT_FIXTURE,
    entityName: null,
    entityKind: null,
    comparator: null,
    threshold: null,
    period: null,
    unresolved: null,
    ...partial,
  };
}

export const goldenSet: readonly GoldenFixture[] = [
  // ── match_winner ────────────────────────────────────────────────────────
  {
    text: 'France win this easy',
    expected: parseOf({ claimType: 'match_winner', entityName: 'France', entityKind: 'team' }),
  },
  {
    text: 'brazil are winning tonight, calling it',
    expected: parseOf({ claimType: 'match_winner', entityName: 'Brazil', entityKind: 'team' }),
  },
  {
    text: 'im telling you france smash them today',
    expected: parseOf({ claimType: 'match_winner', entityName: 'France', entityKind: 'team' }),
    tags: ['slang'],
  },
  {
    text: 'portugal win but only just',
    expected: parseOf({
      claimType: 'match_winner',
      fixtureId: 9103,
      entityName: 'Portugal',
      entityKind: 'team',
    }),
    contextFixtureId: 9103,
  },
  {
    text: 'england to win in 90',
    expected: parseOf({
      claimType: 'match_winner',
      fixtureId: 9102,
      entityName: 'England',
      entityKind: 'team',
      period: 'FT_90',
    }),
    contextFixtureId: 9102,
  },
  {
    text: 'france win even if it goes to pens',
    expected: parseOf({
      claimType: 'match_winner',
      entityName: 'France',
      entityKind: 'team',
      period: 'FT',
    }),
  },
  {
    text: 'netherlands through to the next round, book it',
    expected: parseOf({
      claimType: 'match_winner',
      fixtureId: 9104,
      entityName: 'Netherlands',
      entityKind: 'team',
      period: 'FT',
    }),
    contextFixtureId: 9104,
  },
  {
    text: 'messi wins it for argentina',
    expected: parseOf({
      claimType: 'match_winner',
      fixtureId: 9102,
      entityName: 'Argentina',
      entityKind: 'team',
    }),
    contextFixtureId: 9102,
  },
  {
    text: 'argentina win this 100%',
    expected: parseOf({
      claimType: 'match_winner',
      fixtureId: 9102,
      entityName: 'Argentina',
      entityKind: 'team',
    }),
    contextFixtureId: 9102,
  },
  {
    text: 'ingerland win it all lads',
    expected: parseOf({
      claimType: 'match_winner',
      fixtureId: 9102,
      entityName: 'England',
      entityKind: 'team',
    }),
    contextFixtureId: 9102,
    tags: ['slang', 'typo'],
  },
  {
    text: 'france win this, loser sends £20',
    expected: parseOf({ claimType: 'match_winner', entityName: 'France', entityKind: 'team' }),
    tags: ['monetary_forfeit'],
  },

  // ── totals_ou ───────────────────────────────────────────────────────────
  {
    text: 'over 2.5 goals in this one, easy',
    expected: parseOf({ claimType: 'totals_ou', comparator: 'gte', threshold: 2.5 }),
  },
  {
    text: 'under 2.5 tonight lads, cagey one',
    expected: parseOf({ claimType: 'totals_ou', comparator: 'lte', threshold: 2.5 }),
  },
  {
    text: 'goals galore, over 3.5 in this',
    expected: parseOf({ claimType: 'totals_ou', comparator: 'gte', threshold: 3.5 }),
    tags: ['slang'],
  },
  {
    text: 'germany netherlands is going over 2.5 trust',
    expected: parseOf({
      claimType: 'totals_ou',
      fixtureId: 9104,
      comparator: 'gte',
      threshold: 2.5,
    }),
    contextFixtureId: 9104,
    tags: ['slang'],
  },
  {
    text: 'u2.5 tonight',
    expected: parseOf({ claimType: 'totals_ou', comparator: 'lte', threshold: 2.5 }),
    tags: ['slang', 'typo'],
  },

  // ── team_scores_n ───────────────────────────────────────────────────────
  {
    text: 'england score 3 today, book it',
    expected: parseOf({
      claimType: 'team_scores_n',
      fixtureId: 9102,
      entityName: 'England',
      entityKind: 'team',
      comparator: 'gte',
      threshold: 3,
    }),
    contextFixtureId: 9102,
  },
  {
    text: 'spain to score at least 2',
    expected: parseOf({
      claimType: 'team_scores_n',
      fixtureId: 9103,
      entityName: 'Spain',
      entityKind: 'team',
      comparator: 'gte',
      threshold: 2,
    }),
    contextFixtureId: 9103,
  },
  {
    text: "brazil wont even score",
    expected: parseOf({
      claimType: 'team_scores_n',
      entityName: 'Brazil',
      entityKind: 'team',
      comparator: 'eq',
      threshold: 0,
    }),
    tags: ['typo'],
  },
  {
    text: 'no way brazil score more than 1',
    expected: parseOf({
      claimType: 'team_scores_n',
      entityName: 'Brazil',
      entityKind: 'team',
      comparator: 'lte',
      threshold: 1,
    }),
  },
  {
    text: '3 or more for germany tonight',
    expected: parseOf({
      claimType: 'team_scores_n',
      fixtureId: 9104,
      entityName: 'Germany',
      entityKind: 'team',
      comparator: 'gte',
      threshold: 3,
    }),
    contextFixtureId: 9104,
  },
  {
    text: 'clean sheet for spain tonight',
    expected: parseOf({
      claimType: 'team_scores_n',
      fixtureId: 9103,
      entityName: 'Portugal',
      entityKind: 'team',
      comparator: 'eq',
      threshold: 0,
    }),
    contextFixtureId: 9103,
    tags: ['slang'],
  },

  // ── btts ────────────────────────────────────────────────────────────────
  {
    text: 'both teams to score, im calling it',
    expected: parseOf({ claimType: 'btts' }),
  },
  {
    text: 'btts tonight easy',
    expected: parseOf({ claimType: 'btts' }),
    tags: ['slang'],
  },

  // ── player_scores_n ─────────────────────────────────────────────────────
  {
    text: 'mbappe scores today, guaranteed',
    expected: parseOf({
      claimType: 'player_scores_n',
      entityName: 'Kylian Mbappé',
      entityKind: 'player',
      comparator: 'gte',
      threshold: 1,
    }),
  },
  {
    text: 'mbapé bags a brace tonight',
    expected: parseOf({
      claimType: 'player_scores_n',
      entityName: 'Kylian Mbappé',
      entityKind: 'player',
      comparator: 'gte',
      threshold: 2,
    }),
    tags: ['slang', 'typo'],
  },
  {
    text: 'embape scores 2nite',
    expected: parseOf({
      claimType: 'player_scores_n',
      entityName: 'Kylian Mbappé',
      entityKind: 'player',
      comparator: 'gte',
      threshold: 1,
    }),
    tags: ['typo'],
  },
  {
    text: 'kane scores today mark my words',
    expected: parseOf({
      claimType: 'player_scores_n',
      fixtureId: 9102,
      entityName: 'Harry Kane',
      entityKind: 'player',
      comparator: 'gte',
      threshold: 1,
    }),
    contextFixtureId: 9102,
  },
  {
    text: 'kane over 0.5 goals, free rep',
    expected: parseOf({
      claimType: 'player_scores_n',
      fixtureId: 9102,
      entityName: 'Harry Kane',
      entityKind: 'player',
      comparator: 'gte',
      threshold: 0.5,
    }),
    contextFixtureId: 9102,
    tags: ['slang'],
  },
  {
    text: 'ronaldo scores 2 against spain, calling it now',
    expected: parseOf({
      claimType: 'player_scores_n',
      fixtureId: 9103,
      entityName: 'Cristiano Ronaldo',
      entityKind: 'player',
      comparator: 'gte',
      threshold: 2,
    }),
    contextFixtureId: 9103,
  },
  {
    text: 'vini cooks them today, 1 goal minimum',
    expected: parseOf({
      claimType: 'player_scores_n',
      entityName: 'Vinícius Júnior',
      entityKind: 'player',
      comparator: 'gte',
      threshold: 1,
    }),
    tags: ['slang'],
  },
  {
    text: 'yamal anytime scorer tonight',
    expected: parseOf({
      claimType: 'player_scores_n',
      fixtureId: 9103,
      entityName: 'Lamine Yamal',
      entityKind: 'player',
      comparator: 'gte',
      threshold: 1,
    }),
    contextFixtureId: 9103,
  },
  {
    text: 'bellingham nets tonight',
    expected: parseOf({
      claimType: 'player_scores_n',
      fixtureId: 9102,
      entityName: 'Jude Bellingham',
      entityKind: 'player',
      comparator: 'gte',
      threshold: 1,
    }),
    contextFixtureId: 9102,
    tags: ['slang'],
  },

  // ── comeback ────────────────────────────────────────────────────────────
  {
    text: 'france turn this around from here',
    expected: parseOf({ claimType: 'comeback', entityName: 'France', entityKind: 'team' }),
    tags: ['in_play'],
  },
  {
    text: "we're 1 down but we turn this around",
    expected: parseOf({ claimType: 'comeback', unresolved: 'we' }),
    tags: ['in_play'],
  },
  {
    text: 'argentina comeback incoming',
    expected: parseOf({
      claimType: 'comeback',
      fixtureId: 9102,
      entityName: 'Argentina',
      entityKind: 'team',
    }),
    contextFixtureId: 9102,
    tags: ['in_play'],
  },

  // ── non-claims the PREFILTER must kill (no model call ever) ─────────────
  { text: 'what time is kickoff tomorrow?', expected: null, tags: ['prefilter_kill'] },
  { text: 'anyone got a link for the match', expected: null, tags: ['prefilter_kill'] },
  { text: 'lmaooo that ref needs glasses', expected: null, tags: ['prefilter_kill'] },
  { text: 'what a save!!!', expected: null, tags: ['prefilter_kill'] },
  { text: 'im getting pizza before the game, anyone want some', expected: null, tags: ['prefilter_kill'] },
  { text: 'GOAL!!!!! get in there', expected: null, tags: ['prefilter_kill'] },
  { text: 'traffic is mad, running late', expected: null, tags: ['prefilter_kill'] },
  { text: 'did you see the lineup yet?', expected: null, tags: ['prefilter_kill'] },
  { text: 'this commentator is unbearable', expected: null, tags: ['prefilter_kill'] },
  { text: 'half time already?', expected: null, tags: ['prefilter_kill'] },
  { text: 'my dog just ate my burger 😂', expected: null, tags: ['prefilter_kill'] },
  { text: 'same time next week lads?', expected: null, tags: ['prefilter_kill'] },
  { text: "who's playing tonight?", expected: null, tags: ['prefilter_kill'] },
  { text: 'unreal atmosphere at the stadium', expected: null, tags: ['prefilter_kill'] },
  { text: 'cook us dinner tonight lads', expected: null, tags: ['prefilter_kill'] },

  // ── non-claims that pass the prefilter; CLASSIFIER must reject ──────────
  { text: 'france scored 2 last week', expected: null, tags: ['needs_classifier'] },
  { text: 'remember when brazil won 7-1', expected: null, tags: ['needs_classifier'] },
  { text: 'mbappe has 4 goals this tournament', expected: null, tags: ['needs_classifier'] },
  {
    text: 'bet you 10 quid the ref gives a pen',
    expected: null,
    tags: ['needs_classifier', 'monetary_forfeit'],
  },
  { text: 'england were winning until that red card', expected: null, tags: ['needs_classifier'] },
  { text: 'over 60000 fans in the stadium apparently', expected: null, tags: ['needs_classifier'] },
  { text: 'spain won the last world cup', expected: null, tags: ['needs_classifier'] },
  { text: "if kane scores i'll cry", expected: null, tags: ['needs_classifier'] },
];
