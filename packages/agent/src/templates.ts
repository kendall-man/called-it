/**
 * Hand-written persona template bank — game-show register, never sportsbook.
 *
 * Every consumer-facing string the bot sends originates here. Placeholders
 * use `{name}` syntax; unknown placeholders are left intact so tests catch
 * missing vars. Multiple variants per key keep copy fresh; selection is a
 * deterministic hash of (key, vars) so retries render identical messages.
 *
 * Register rules (PRD): "calls locked" not "staking frozen"; "Rep on the
 * line" not "stakes"; "×9 Rep" never odds notation; no currency anywhere.
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

export const PERSONA_TEMPLATES: Record<PersonaTemplateKey, readonly string[]> = {
  intro_disclosure: [
    '🎙️ {botName} in the chat — your match-night game show host. Someone makes a big call, I put it on the record, the group backs it or doubts it with Rep, and the official feed settles it before the argument ends. Heads up: your admins enabled always-on listening in this group (they can turn it off any time), and settled calls get a public receipt page. Nothing of value ever changes hands — Rep is worthless by design, the bragging rights are not. Type /help for the rules.',
  ],
  priced_nudge: [
    'Big call from {claimer}! “{quote}” — running at ×{multiplier} Rep right now. Who’s making them prove it?',
    '{claimer} just said it out loud: “{quote}”. That call pays ×{multiplier} Rep if it lands. Anyone making them prove it?',
  ],
  clarify_question: [
    'One thing before we lock it in, {claimer}: {question}',
    'Almost there, {claimer} — quick ruling first: {question}',
  ],
  counter_offer: [
    'Can’t book that exactly as said, {claimer} — {reason}. Closest call I can settle clean: {offer}. Take it?',
    'Straight with you, {claimer}: {reason}. Here’s the nearest call I can prove: {offer}. Deal?',
  ],
  confirm_gate: [
    'Here it is, {claimer}: {terms} — locking at ×{multiplier} Rep. Tap “That’s my shout” and it’s official.',
    'Read it back, {claimer}: {terms} at ×{multiplier} Rep. One tap on “That’s my shout” and the call is live.',
  ],
  claim_card: [
    '📋 THE CALL — {claimer}: “{quote}”\nTerms: {terms}\nLocked at ×{multiplier} Rep · {provenance}\nBackers: {backers} · Doubters: {doubters} · Pot: {pot} Rep',
  ],
  back_ack: [
    '{user} backs it — {amount} Rep on the line at ×{multiplier}. Locked in.',
    '{user} is a believer: {amount} Rep riding at ×{multiplier}. Locked.',
  ],
  doubt_ack: [
    '{user} doubts it — {amount} Rep on the line at ×{multiplier}. Locked in.',
    '{user} says no chance: {amount} Rep against at ×{multiplier}. Locked.',
  ],
  freeze: [
    '⚠️ {reason} — calls locked on {market}. Nobody moves until the ruling.',
    '⏸️ Hold everything: {reason}. {market} is locked while we wait it out.',
  ],
  unfreeze: [
    '✅ All clear — {market} is back open. Make your calls.',
    '▶️ Ruling’s in, drama’s over: {market} reopens. Back it or doubt it.',
  ],
  goal_narration: [
    '⚽ {minute}′ — {scorer} scores for {team}! {impact}',
    '⚽ It’s in! {scorer}, minute {minute}, {team} on the board. {impact}',
  ],
  settlement_receipt_won: [
    '🏆 CALLED IT. {claimer}’s shout lands: {terms}. Paid at ×{multiplier} — {payout} Rep to the believers. Receipt: {url}',
    '🏆 Take a bow, {claimer}. {terms} — done and settled at ×{multiplier}. {payout} Rep out to the backers. Receipt: {url}',
  ],
  settlement_receipt_lost: [
    '❌ Not this time. {claimer}’s call — {terms} — doesn’t land. {payout} Rep to the doubters. Receipt: {url}',
    '❌ The board says no, {claimer}. {terms} falls short — {payout} Rep to the doubters. Receipt: {url}',
  ],
  void_refund: [
    '🚫 {reason} — this call is off. Every Rep goes back where it came from. Nobody wins, nobody loses.',
    '🚫 Ruling from upstairs: {reason}. Call voided, all Rep refunded in full.',
  ],
  stale_tap: [
    'That ship has sailed, {user} — this one is already {state}. Catch the next call.',
    'Too slow, {user}! This call is {state} now. There’ll be another along in a minute.',
  ],
  insufficient_rep: [
    'Not enough Rep in the tank, {user} — you’ve got {balance}. The matchday top-up lands in the morning.',
    'Big spirit, {user}, small balance: {balance} Rep. Top-up arrives on the next matchday.',
  ],
  pick_a_lane: [
    'Pick a lane, {user} — you’re already on the other side of this one.',
    'You can’t back it and doubt it, {user}. Pick a lane and stay in it.',
  ],
  forfeit_prompt: [
    'Want real drama on this, {claimer}? Attach a forfeit — pick one below. (Bragging rights only, nothing of value.)',
    'Raise the temperature, {claimer}? Add a forfeit to the call — choose from the pack below.',
  ],
  forfeit_callout: [
    '📣 Forfeit time! {loser} owes the group: “{forfeit}”. An admin taps Honored ✅ when it’s done. We do not forget.',
    '📣 The group remembers, {loser}: “{forfeit}”. Deliver it — an admin will tap Honored ✅.',
  ],
  morning_slate: [
    '☀️ Matchday! On today’s card: {fixtures}. Balances topped up — bring your big calls. {pending}',
    '☀️ Wake up, it’s matchday. Today: {fixtures}. Rep floors restored. {pending}',
  ],
  leaderboard_header: [
    '🏆 {groupName} — the season table. Rep, records, streaks. Who actually calls it?',
    '🏆 The table of truth for {groupName}. Talk is free — the table is not fooled.',
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
  // Non-null: every key in the bank has at least one variant.
  return variant as string;
}
