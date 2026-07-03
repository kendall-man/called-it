/**
 * Deterministic prefilter — the gate that kills clearly-non-claim chatter
 * before any model call (PRD: ">95% of messages die here").
 *
 * Pure regex + entity dictionary; the dictionary is rebuilt daily by the
 * engine from the fixtures/players tables (canonical names + accumulated
 * aliases/misspellings) and injected per call.
 *
 * Decision rule (on diacritic-folded lowercase text):
 *   pass  ⇐ standalone claim pattern            ("btts", "over 2.5", "turn it around")
 *   pass  ⇐ entity hit AND claim/threshold cue  ("france win this")
 *   pass  ⇐ claim cue AND a number              ("scores 2nite" — typo'd names)
 *   kill  ⇐ everything else
 */

export interface PrefilterEntities {
  teamNames: string[];
  playerNames: string[];
}

/** Shortest dictionary entry we trust — 1–2 char aliases match everything. */
const MIN_ENTITY_LENGTH = 3;

/** Verbs/phrases that signal someone is making a call, incl. common slang. */
const CLAIM_SIGNAL_TERMS = [
    'scores?', 'scored', 'scoring', 'to score',
    'wins?', 'winning', 'won',
    'beats?', 'beating', 'batters?', 'battered',
    'smash(?:es|ed)?', 'smoke[sd]?', 'destroys?', 'destroyed', 'demolish(?:es|ed)?',
    'cook(?:s|ed|ing)?', 'walks? it',
    'hat[ -]?tricks?', 'braces?', 'clean sheets?', 'shut ?outs?',
    'btts', 'both teams',
    'nets?', 'netted', 'bags?', 'bagged', 'finishes', 'anytime',
    'concedes?', 'conceded',
    'comebacks?', 'come back', 'turn (?:it|this) around', 'turnaround',
    'draws?', 'drew',
    'advances?', 'advancing', 'go(?:es)? through', 'through to', 'qualif(?:y|ies)', 'knock(?:s|ed)? out',
    'calling it', 'call it', 'called it', 'book it', 'bookit',
    'mark my words', 'telling you', 'guarantees?d?', 'lock it in',
    'bet(?:s|ting)?', 'easy (?:win|dub)',
];

const CLAIM_SIGNAL_RE = new RegExp(`\\b(?:${CLAIM_SIGNAL_TERMS.join('|')})\\b`, 'i');

/** Numeric thresholds: over/under lines, "3+", "3 or more", "2 goals". */
const THRESHOLD_RE = /\b(?:over|under|o|u)\s*\d+(?:\.\d+)?\b|\b\d+\s*(?:\+|or more|plus)\b|\b\d+(?:\.\d+)?\s*goals?\b/i;

/** Any digit or small spelled-out count. */
const NUMBERISH_RE = /\d|\b(?:one|two|three|four|five|six)\b/i;

/** Patterns strong enough to pass without a named entity. */
const STANDALONE_RE = /\bbtts\b|\bboth teams(?: to score| score| scoring)?\b|\bclean sheets?\b|\bhat[ -]?tricks?\b|\bcomebacks?\b|\bturn (?:it|this) around\b|\b(?:over|under|o|u)\s*\d+(?:\.\d+)?\b/i;

/** Combining diacritical marks left behind by NFKD decomposition. */
const COMBINING_MARKS_RE = /[\u0300-\u036f]/g;

/** Lowercase and strip diacritics so "Mbappé"/"mbape" style aliases align. */
export function normalizeForMatch(text: string): string {
  return text.normalize('NFKD').replace(COMBINING_MARKS_RE, '').toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasEntityHit(normalizedText: string, names: readonly string[]): boolean {
  for (const rawName of names) {
    const name = normalizeForMatch(rawName).trim();
    if (name.length < MIN_ENTITY_LENGTH) continue;
    const bounded = new RegExp(`(?<![a-z0-9])${escapeRegExp(name)}(?![a-z0-9])`);
    if (bounded.test(normalizedText)) return true;
  }
  return false;
}

export function prefilter(text: string, entities: PrefilterEntities): boolean {
  const normalized = normalizeForMatch(text);
  if (normalized.trim().length === 0) return false;

  if (STANDALONE_RE.test(normalized)) return true;

  const claimCue = CLAIM_SIGNAL_RE.test(normalized);
  const thresholdCue = THRESHOLD_RE.test(normalized);
  const entityHit = hasEntityHit(normalized, [
    ...entities.teamNames,
    ...entities.playerNames,
  ]);

  if (entityHit && (claimCue || thresholdCue)) return true;
  if (claimCue && (thresholdCue || NUMBERISH_RE.test(normalized))) return true;

  return false;
}
