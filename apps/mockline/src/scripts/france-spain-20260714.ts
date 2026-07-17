/**
 * THE REAL MATCH: France 0–2 Spain, 2026 World Cup semifinal,
 * Dallas Stadium, 2026-07-14 — reconstructed from published reports:
 *
 *   10'  Rabiot booked (stepping on Olmo)
 *   22'  Digne fouls Yamal in the box — quick whistle, NO VAR review
 *        (France's unreviewed-handball complaint is part of the lore) —
 *        Oyarzabal converts left-footed past Maignan, 0–1
 *   30'  Saliba off injured (Lacroix on) — inert comment beat
 *   58'  Porro give-and-go with Olmo, side-footed past Maignan, 0–2
 *   90'  Cucurella's box tackle denies Mbappé (possible-event flash)
 *   90+7 played; FT 0–2. Spain: 1.63 xG, scored both shots on target.
 *
 * Pre-match odds are the real FanDuel 90-minute book demargined
 * (France +155 / draw +190 / Spain +210, O/U 2.5) — France were favorites.
 * In-play odds moves are approximations; every match EVENT is the real one.
 * Rosters are the actual starting XIs + the substitutes who came on.
 */

import type { MatchScript } from '../types.js';

const MIN = 60_000;
const SEC = 1_000;

export const FRANCE_PLAYER_IDS = {
  MBAPPE: 7001,
  DEMBELE: 7003,
  TCHOUAMENI: 7004,
  RABIOT: 7006,
  OLISE: 7007,
  BARCOLA: 7008,
  DIGNE: 7009,
  MAIGNAN: 7010,
  SALIBA: 7011,
  UPAMECANO: 7012,
  KOUNDE: 7013,
  DOUE: 7014,
  CHERKI: 7015,
  KONE: 7016,
  LACROIX: 7017,
} as const;

export const SPAIN_PLAYER_IDS = {
  YAMAL: 7201,
  OYARZABAL: 7202,
  PORRO: 7203,
  OLMO: 7204,
  RODRI: 7205,
  FABIAN_RUIZ: 7206,
  BAENA: 7207,
  CUCURELLA: 7208,
  LAPORTE: 7209,
  CUBARSI: 7210,
  SIMON: 7211,
  PEDRI: 7212,
  FERRAN_TORRES: 7213,
} as const;

export const FRANCE_SPAIN_SEMI: MatchScript = {
  key: 'france-spain',
  competition: 'World Cup 2026 — Semifinal (Dallas)',
  competitionId: 901,
  home: {
    participantId: 801,
    name: 'France',
    players: [
      { normativeId: FRANCE_PLAYER_IDS.MAIGNAN, name: 'Mike Maignan', starter: true },
      { normativeId: FRANCE_PLAYER_IDS.UPAMECANO, name: 'Dayot Upamecano', starter: true },
      { normativeId: FRANCE_PLAYER_IDS.SALIBA, name: 'William Saliba', starter: true },
      { normativeId: FRANCE_PLAYER_IDS.KOUNDE, name: 'Jules Koundé', starter: true },
      { normativeId: FRANCE_PLAYER_IDS.DIGNE, name: 'Lucas Digne', starter: true },
      { normativeId: FRANCE_PLAYER_IDS.TCHOUAMENI, name: 'Aurélien Tchouaméni', starter: true },
      { normativeId: FRANCE_PLAYER_IDS.RABIOT, name: 'Adrien Rabiot', starter: true },
      { normativeId: FRANCE_PLAYER_IDS.DEMBELE, name: 'Ousmane Dembélé', starter: true },
      { normativeId: FRANCE_PLAYER_IDS.OLISE, name: 'Michael Olise', starter: true },
      { normativeId: FRANCE_PLAYER_IDS.BARCOLA, name: 'Bradley Barcola', starter: true },
      { normativeId: FRANCE_PLAYER_IDS.MBAPPE, name: 'Kylian Mbappé', starter: true },
      { normativeId: FRANCE_PLAYER_IDS.LACROIX, name: 'Maxence Lacroix', starter: false },
      { normativeId: FRANCE_PLAYER_IDS.KONE, name: 'Manu Koné', starter: false },
      { normativeId: FRANCE_PLAYER_IDS.DOUE, name: 'Désiré Doué', starter: false },
      { normativeId: FRANCE_PLAYER_IDS.CHERKI, name: 'Rayan Cherki', starter: false },
    ],
  },
  away: {
    participantId: 803,
    name: 'Spain',
    players: [
      { normativeId: SPAIN_PLAYER_IDS.SIMON, name: 'Unai Simón', starter: true },
      { normativeId: SPAIN_PLAYER_IDS.PORRO, name: 'Pedro Porro', starter: true },
      { normativeId: SPAIN_PLAYER_IDS.CUBARSI, name: 'Pau Cubarsí', starter: true },
      { normativeId: SPAIN_PLAYER_IDS.LAPORTE, name: 'Aymeric Laporte', starter: true },
      { normativeId: SPAIN_PLAYER_IDS.CUCURELLA, name: 'Marc Cucurella', starter: true },
      { normativeId: SPAIN_PLAYER_IDS.RODRI, name: 'Rodri', starter: true },
      { normativeId: SPAIN_PLAYER_IDS.FABIAN_RUIZ, name: 'Fabián Ruiz', starter: true },
      { normativeId: SPAIN_PLAYER_IDS.YAMAL, name: 'Lamine Yamal', starter: true },
      { normativeId: SPAIN_PLAYER_IDS.OLMO, name: 'Dani Olmo', starter: true },
      { normativeId: SPAIN_PLAYER_IDS.BAENA, name: 'Álex Baena', starter: true },
      { normativeId: SPAIN_PLAYER_IDS.OYARZABAL, name: 'Mikel Oyarzabal', starter: true },
      { normativeId: SPAIN_PLAYER_IDS.PEDRI, name: 'Pedri', starter: false },
      { normativeId: SPAIN_PLAYER_IDS.FERRAN_TORRES, name: 'Ferran Torres', starter: false },
    ],
  },
  timeline: [
    // ── Pre-match ────────────────────────────────────────────────────────
    { atMs: -55 * MIN, kind: 'lineups' },
    // Real FanDuel 90' book demargined: +155 / +190 / +210 ⇒ France favorites.
    {
      atMs: -50 * MIN,
      kind: 'odds',
      oneX2: { home: 37.0, draw: 32.5, away: 30.5 },
      totals: { line: 2.5, overPct: 47.0, underPct: 53.0 },
    },
    {
      atMs: -10 * MIN,
      kind: 'odds',
      oneX2: { home: 36.5, draw: 32.5, away: 31.0 },
      totals: { line: 2.5, overPct: 46.5, underPct: 53.5 },
    },

    // ── First half ───────────────────────────────────────────────────────
    { atMs: 0, kind: 'phase', status: 'H1' },
    // 10' Rabiot steps on Olmo — booked.
    { atMs: 9 * MIN + 30 * SEC, kind: 'card', team: 1, card: 'yellow', playerId: FRANCE_PLAYER_IDS.RABIOT },
    // 22' Digne brings down Yamal in the box. Quick whistle, no VAR review.
    { atMs: 20 * MIN + 50 * SEC, kind: 'odds', suspended: true },
    { atMs: 21 * MIN, kind: 'possible_event', team: 2, flag: 'penalty' },
    { atMs: 21 * MIN + 30 * SEC, kind: 'goal', team: 2, playerId: SPAIN_PLAYER_IDS.OYARZABAL, goalType: 'Penalty' },
    {
      atMs: 23 * MIN,
      kind: 'odds',
      oneX2: { home: 15.0, draw: 24.0, away: 61.0 },
      totals: { line: 2.5, overPct: 55.0, underPct: 45.0 },
    },
    // 30' Saliba limps off (Lacroix on) — narrative beat, settlement-inert.
    { atMs: 29 * MIN + 30 * SEC, kind: 'comment' },
    { atMs: 45 * MIN, kind: 'phase', status: 'HT' },

    // ── Second half ──────────────────────────────────────────────────────
    { atMs: 45 * MIN + 1 * SEC, kind: 'phase', status: 'H2' },
    // 58' Porro's give-and-go with Olmo, side-footed past Maignan.
    { atMs: 57 * MIN + 20 * SEC, kind: 'odds', suspended: true },
    { atMs: 57 * MIN + 40 * SEC, kind: 'goal', team: 2, playerId: SPAIN_PLAYER_IDS.PORRO, goalType: 'Shot' },
    {
      atMs: 59 * MIN,
      kind: 'odds',
      oneX2: { home: 1.5, draw: 6.5, away: 92.0 },
      totals: { line: 2.5, overPct: 47.0, underPct: 53.0 },
    },
    // 90' Mbappé through — Cucurella's tackle in the box denies him.
    { atMs: 89 * MIN + 30 * SEC, kind: 'additional_time', minutes: 7 },
    { atMs: 90 * MIN, kind: 'possible_event', team: 1, flag: 'goal' },
    { atMs: 90 * MIN + 40 * SEC, kind: 'comment' },
    // 90+7 played.
    { atMs: 97 * MIN, kind: 'phase', status: 'F' },
  ],
};
