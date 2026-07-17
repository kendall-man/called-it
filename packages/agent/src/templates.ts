/**
 * Hand-written persona template bank — game-show warmth, broker honesty.
 *
 * Every consumer-facing string the bot sends originates here. Placeholders
 * use `{name}` syntax; unknown placeholders are left intact so tests catch
 * missing vars. Multiple variants per key keep copy fresh; selection is a
 * deterministic hash of (key, vars) so retries render identical messages.
 *
 * Register rules: calls use two explicit outcomes, amounts are devnet test
 * SOL, and prices are plain percentages. The devnet disclosure appears once,
 * at onboarding — routine lines never repeat value disclaimers.
 */

export const PERSONA_TEMPLATE_KEYS = [
  'intro_disclosure',
  'priced_nudge',
  'clarify_question',
  'counter_offer',
  'confirm_gate',
  'claim_card',
  'back_ack',
  'doubt_ack',
  'freeze',
  'unfreeze',
  'goal_narration',
  'settlement_receipt_won',
  'settlement_receipt_lost',
  'void_refund',
  'stale_tap',
  'insufficient_rep',
  'pick_a_lane',
  'forfeit_prompt',
  'forfeit_callout',
  'morning_slate',
  'leaderboard_header',
] as const;

export type PersonaTemplateKey = (typeof PERSONA_TEMPLATE_KEYS)[number];

export type PersonaVars = Record<string, string | number>;

export const PERSONA_TEMPLATES: Record<
  PersonaTemplateKey,
  readonly [string, ...string[]]
> = {
  intro_disclosure: [
    '🎙️ {botName} is ready. Mention me on a call or use /bookit yourself. I ask the speaker to confirm exact terms before I post the two sides of the call. Runs on Solana devnet — these are test tokens. Type /help for the rules.',
  ],
  priced_nudge: [
    '{claimer}, I read “{quote}” as this call. The feed estimate is {probability}%. Confirm the exact terms before I post the two choices.',
    '{claimer}, this sounds like a call: “{quote}”. The feed estimate is {probability}%. Confirm my reading before anything opens.',
  ],
  clarify_question: [
    'One thing before I book it, {claimer}: {question}',
    'Almost there, {claimer} — quick ruling first: {question}',
  ],
  counter_offer: [
    'Can’t book that exactly as said, {claimer} — {reason}. Closest call I can settle clean: {offer}. Take it?',
    'Straight with you, {claimer}: {reason}. Here’s the nearest call I can prove: {offer}. Deal?',
  ],
  confirm_gate: [
    '{claimer}, confirm this exact call: {terms}. The feed estimate is {probability}%. Reply confirm before I post the two sides.',
    '{claimer}, please confirm my reading: {terms}. The feed estimate is {probability}%. I will open the two choices only after you confirm.',
  ],
  claim_card: [
    '📋 THE CALL — {claimer}: “{quote}”\nTerms: {terms}\nFeed says {probability}% · {provenance}\nBacking: {backers} · Against: {doubters} · Matched: {matched}',
  ],
  back_ack: [
    '{user} backs it — {amount} on the line. Locked in.',
    '{user} is a believer: {amount} riding on it. Locked.',
  ],
  doubt_ack: [
    '{user} bets against — {amount} says it won’t. Locked in.',
    '{user} fades it: {amount} against. Locked.',
  ],
  freeze: [
    '⚠️ {reason} — bets locked on {market}. Nobody moves until the ruling.',
    '⏸️ Hold everything: {reason}. {market} is locked while we wait it out.',
  ],
  unfreeze: [
    '✅ All clear — {market} is back open. Back it or bet against.',
    '▶️ Ruling’s in, drama’s over: {market} reopens. Pick your side.',
  ],
  goal_narration: [
    '⚽ {minute}′ — {scorer} scores for {team}! {impact}',
    '⚽ It’s in! {scorer}, minute {minute}, {team} on the board. {impact}',
  ],
  settlement_receipt_won: [
    '🏆 CALLED IT. {claimer}’s shout lands: {terms}. {payouts} Receipt: {url}',
    '🏆 Take a bow, {claimer}. {terms} — done and settled. {payouts} Receipt: {url}',
  ],
  settlement_receipt_lost: [
    '❌ Not this time. {claimer}’s call — {terms} — doesn’t land. {payouts} Receipt: {url}',
    '❌ The feed says no, {claimer}. {terms} falls short. {payouts} Receipt: {url}',
  ],
  void_refund: [
    '🚫 {reason} — this call is off. Every SOL stake goes straight back. Nobody wins, nobody loses.',
    '🚫 Ruling from upstairs: {reason}. Call voided, all SOL refunded in full.',
  ],
  stale_tap: [
    'That ship has sailed, {user} — this one is already {state}. Catch the next call.',
    'Too slow, {user}! This call is {state} now. There’ll be another along in a minute.',
  ],
  insufficient_rep: [
    'Not enough test SOL, {user}. Your available balance is {balance}. Open /deposit to add more.',
    '{user}, your available test SOL balance is {balance}. Use /deposit before choosing a position.',
  ],
  pick_a_lane: [
    'Pick a lane, {user} — you’re already on the other side of this one.',
    'You can’t back it and bet against it, {user}. Pick a side and stay in it.',
  ],
  forfeit_prompt: [
    'Feeling it, {claimer}? Put some SOL where your mouth is — back your own call below.',
    'Believe it, {claimer}? Back your own shout below and let the group come at you.',
  ],
  forfeit_callout: [
    '📣 The feed has spoken on {loser}’s call: “{forfeit}”. Receipts don’t forget.',
    '📣 On the record, {loser}: “{forfeit}”. The receipt page has it forever.',
  ],
  morning_slate: [
    '☀️ Matchday! On today’s card: {fixtures}. Bring your big calls. {pending}',
    '☀️ Wake up, it’s matchday. Today: {fixtures}. Who’s calling it? {pending}',
  ],
  leaderboard_header: [
    '🏆 {groupName} — every call on the record. Receipts don’t lie.',
    '🏆 The receipts for {groupName}. Talk is free — the feed is not fooled.',
  ],
};

const PLACEHOLDER_RE = /\{([a-zA-Z0-9_]+)\}/g;

/**
 * Substitute `{name}` placeholders. Unknown placeholders stay verbatim so a
 * missing var is loudly visible in tests rather than silently blanked.
 */
export function renderTemplate(template: string, vars: PersonaVars): string {
  return template.replace(PLACEHOLDER_RE, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}

/** djb2 — tiny stable hash for deterministic variant selection. */
function stableHash(input: string): number {
  const DJB2_SEED = 5381;
  const DJB2_MULTIPLIER = 33;
  let hash = DJB2_SEED;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * DJB2_MULTIPLIER + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/** Pick a template variant deterministically from (key, vars). */
export function selectTemplate(key: PersonaTemplateKey, vars: PersonaVars): string {
  const variants = PERSONA_TEMPLATES[key];
  const fingerprint = key + JSON.stringify(Object.entries(vars).sort(([a], [b]) => a.localeCompare(b)));
  const variant = variants[stableHash(fingerprint) % variants.length];
  return variant ?? variants[0];
}
