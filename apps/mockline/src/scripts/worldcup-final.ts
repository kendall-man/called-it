/**
 * The flagship staging script: a World Cup final with every dramatic beat the
 * reducer knows — pre-match lineups and odds, an early goal, a penalty
 * equalizer, a VAR-DISCARDED go-ahead goal, a late brace, odds suspensions
 * around key moments, and a 3-1 full-time settle.
 *
 * Player ids here must match seed-players.sql — claims like "Mbappé scores
 * twice" ground against the staging players/fixture_players tables.
 */

import type { MatchScript } from '../types.js';

const MIN = 60_000;
const SEC = 1_000;

export const PLAYER_IDS = {
  MBAPPE: 7001,
  GRIEZMANN: 7002,
  DEMBELE: 7003,
  TCHOUAMENI: 7004,
  KANTE: 7005,
  MAIGNAN: 7010,
  MESSI: 7101,
  ALVAREZ: 7102,
  LAUTARO: 7103,
  DE_PAUL: 7104,
  ENZO: 7105,
  EMI_MARTINEZ: 7110,
} as const;

export const WORLDCUP_FINAL: MatchScript = {
  key: 'worldcup-final',
  competition: 'World Cup — Staging Final',
  competitionId: 900,
  home: {
    participantId: 801,
    name: 'France',
    players: [
      { normativeId: PLAYER_IDS.MBAPPE, name: 'Kylian Mbappé', starter: true },
      { normativeId: PLAYER_IDS.GRIEZMANN, name: 'Antoine Griezmann', starter: true },
      { normativeId: PLAYER_IDS.DEMBELE, name: 'Ousmane Dembélé', starter: true },
      { normativeId: PLAYER_IDS.TCHOUAMENI, name: 'Aurélien Tchouaméni', starter: true },
      { normativeId: PLAYER_IDS.KANTE, name: "N'Golo Kanté", starter: false },
      { normativeId: PLAYER_IDS.MAIGNAN, name: 'Mike Maignan', starter: true },
    ],
  },
  away: {
    participantId: 802,
    name: 'Argentina',
    players: [
      { normativeId: PLAYER_IDS.MESSI, name: 'Lionel Messi', starter: true },
      { normativeId: PLAYER_IDS.ALVAREZ, name: 'Julián Álvarez', starter: true },
      { normativeId: PLAYER_IDS.LAUTARO, name: 'Lautaro Martínez', starter: false },
      { normativeId: PLAYER_IDS.DE_PAUL, name: 'Rodrigo De Paul', starter: true },
      { normativeId: PLAYER_IDS.ENZO, name: 'Enzo Fernández', starter: true },
      { normativeId: PLAYER_IDS.EMI_MARTINEZ, name: 'Emiliano Martínez', starter: true },
    ],
  },
  timeline: [
    // ── Pre-match (real wall time before kickoff) ────────────────────────
    { atMs: -50 * MIN, kind: 'lineups' },
    {
      atMs: -45 * MIN,
      kind: 'odds',
      oneX2: { home: 41.0, draw: 26.5, away: 32.5 },
      totals: { line: 2.5, overPct: 54.0, underPct: 46.0 },
    },
    {
      atMs: -15 * MIN,
      kind: 'odds',
      oneX2: { home: 42.5, draw: 26.0, away: 31.5 },
      totals: { line: 2.5, overPct: 55.0, underPct: 45.0 },
    },

    // ── First half ───────────────────────────────────────────────────────
    { atMs: 0, kind: 'phase', status: 'H1' },
    { atMs: 9 * MIN, kind: 'possible_event', team: 1 },
    { atMs: 9 * MIN + 40 * SEC, kind: 'comment' }, // roar came to nothing
    { atMs: 12 * MIN + 30 * SEC, kind: 'odds', suspended: true },
    { atMs: 13 * MIN, kind: 'goal', team: 1, playerId: PLAYER_IDS.MBAPPE, goalType: 'Shot' },
    {
      atMs: 14 * MIN,
      kind: 'odds',
      oneX2: { home: 55.0, draw: 22.5, away: 22.5 },
      totals: { line: 2.5, overPct: 58.0, underPct: 42.0 },
    },
    { atMs: 27 * MIN, kind: 'card', team: 2, card: 'yellow', playerId: PLAYER_IDS.DE_PAUL },
    { atMs: 35 * MIN, kind: 'possible_event', team: 2 },
    { atMs: 36 * MIN, kind: 'goal', team: 2, playerId: PLAYER_IDS.MESSI, goalType: 'Penalty' },
    {
      atMs: 37 * MIN,
      kind: 'odds',
      oneX2: { home: 44.0, draw: 26.0, away: 30.0 },
      totals: { line: 2.5, overPct: 60.0, underPct: 40.0 },
    },
    { atMs: 44 * MIN + 30 * SEC, kind: 'additional_time', minutes: 3 },
    { atMs: 45 * MIN, kind: 'phase', status: 'HT' },

    // ── Second half (the materializer inserts the wall-time break here) ──
    { atMs: 45 * MIN + 1 * SEC, kind: 'phase', status: 'H2' },
    {
      atMs: 52 * MIN,
      kind: 'odds',
      oneX2: { home: 43.0, draw: 27.0, away: 30.0 },
      totals: { line: 2.5, overPct: 57.0, underPct: 43.0 },
    },
    // The VAR heartbreak: Álvarez "scores", check, chalked off.
    { atMs: 58 * MIN, kind: 'goal', team: 2, playerId: PLAYER_IDS.ALVAREZ, goalType: 'Shot', tag: 'alvarez-58' },
    { atMs: 58 * MIN + 25 * SEC, kind: 'var_check' },
    { atMs: 59 * MIN + 30 * SEC, kind: 'discard', ofTag: 'alvarez-58' },
    { atMs: 59 * MIN + 50 * SEC, kind: 'var_end' },
    {
      atMs: 61 * MIN,
      kind: 'odds',
      oneX2: { home: 47.0, draw: 25.0, away: 28.0 },
      totals: { line: 2.5, overPct: 55.0, underPct: 45.0 },
    },
    { atMs: 69 * MIN, kind: 'card', team: 1, card: 'yellow', playerId: PLAYER_IDS.TCHOUAMENI },
    { atMs: 73 * MIN + 30 * SEC, kind: 'odds', suspended: true },
    { atMs: 74 * MIN, kind: 'goal', team: 1, playerId: PLAYER_IDS.GRIEZMANN, goalType: 'Head' },
    {
      atMs: 75 * MIN,
      kind: 'odds',
      oneX2: { home: 68.0, draw: 18.0, away: 14.0 },
      totals: { line: 2.5, overPct: 61.0, underPct: 39.0 },
    },
    { atMs: 83 * MIN, kind: 'possible_event', team: 1 },
    { atMs: 83 * MIN + 30 * SEC, kind: 'comment' },
    // The brace — "Mbappé scores 2 today" flips green here.
    { atMs: 88 * MIN, kind: 'goal', team: 1, playerId: PLAYER_IDS.MBAPPE, goalType: 'Shot' },
    { atMs: 90 * MIN, kind: 'additional_time', minutes: 4 },
    { atMs: 94 * MIN, kind: 'phase', status: 'F' },
  ],
};
