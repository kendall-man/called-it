export type CopyVars = Record<string, string | number>;

const NETWORK_VAR = '__solanaNetwork';

function isMainnet(vars: CopyVars): boolean {
  return vars[NETWORK_VAR] === 'mainnet-beta';
}

export type TemplateKey =
  | 'intro'
  | 'help'
  | 'dm_start'
  | 'nudge_priced'
  | 'nudge_unpriced'
  | 'prove_ack'
  | 'clarify'
  | 'counter_offer'
  | 'reject'
  | 'confirm_gate'
  | 'confirm_declined'
  | 'no_price'
  | 'no_line'
  | 'unpriceable'
  | 'already_decided'
  | 'prove_retry'
  | 'hiccup'
  | 'hold_on'
  | 'budget_spent'
  | 'market_live'
  | 'offer_live'
  | 'offer_taken'
  | 'pending_lineup_note'
  | 'lineup_activated'
  | 'var_freeze'
  | 'calls_unlocked'
  | 'goal_alert'
  | 'settle_won'
  | 'settle_lost'
  | 'void_market'
  | 'after_the_moment'
  | 'positions_activated'
  | 'pick_a_lane'
  | 'insufficient_rep'
  | 'cap_reached'
  | 'stake_locked'
  | 'stale'
  | 'not_your_shout'
  | 'claimer_only_terms'
  | 'admin_only'
  | 'settings_intro'
  | 'settings_updated'
  | 'table_header'
  | 'slate_intro'
  | 'replay_started'
  | 'replay_finished'
  | 'replay_blocked_live'
  | 'replay_blocking_call_voided'
  | 'replay_blocked_active'
  | 'replay_unknown_fixture'
  | 'replay_stopped'
  | 'replay_failed'
  | 'replay_position_recorded'
  | 'replay_position_exists'
  | 'bookit_needs_reply'
  | 'window_closed'
  | 'beta_access_required'
  | 'admin_permission_required'
  | 'group_ready'
  | 'private_start'
  | 'group_only_recovery'
  | 'points_unavailable'
  | 'table_link'
  | 'detection_enabled'
  | 'detection_disabled';

function value(vars: CopyVars, key: string, fallback = ''): string {
  const item = vars[key];
  return item === undefined ? fallback : String(item);
}

export const FALLBACK_TEMPLATES: Record<TemplateKey, (vars: CopyVars) => string> = {
  intro: (vars) => isMainnet(vars)
    ? 'Add Called It to a Telegram group. Reply /bookit to your own football call, then choose one of two 0.01 SOL outcomes. Choices and named results are visible to everyone in the group. Use /wallet in private chat to review your verified wallet, and /leaderboard, /mystats, or /table in the group.'
    : 'Add Called It to a Telegram group. Reply /bookit to your own football call, then tap one of two fixed outcomes: "It happens · 0.01 SOL" or "It does not · 0.01 SOL". Choices and named results are visible to everyone in this Telegram group. Use /leaderboard, /mystats, or /table. Correct choices earn 10 points automatically. Test SOL is devnet-only and has no monetary value.',
  help: (vars) => [
    'How this works:',
    '• Add Called It to a Telegram group.',
    '• Reply /bookit to your own football call.',
    isMainnet(vars)
      ? '• Tap one of two 0.01 SOL outcomes: "It happens" or "It does not".'
      : '• Tap one of two fixed outcomes: "It happens · 0.01 SOL" or "It does not · 0.01 SOL".',
    '• Choices and named results are visible to everyone in this Telegram group.',
    '• Correct choices earn 10 points automatically.',
    '',
    isMainnet(vars)
      ? 'Commands: /bookit · /leaderboard · /mystats · /table · /settings · /help. Wallet commands are available in private chat.'
      : 'Commands: /bookit · /leaderboard · /mystats · /table · /settings · /help',
    isMainnet(vars)
      ? 'SOL deposits and withdrawals use Solana mainnet.'
      : 'Test SOL is devnet-only and has no monetary value.',
  ].join('\n'),
  dm_start: (vars) =>
    `I live in group chats — add me to yours and the banter starts pricing itself. ${value(vars, 'addLink')}`,
  nudge_priced: (vars) =>
    `Big shout from ${value(vars, 'claimer', 'someone')}. Data says ${value(vars, 'probabilityPct')}% — anyone want to make them prove it?`,
  nudge_unpriced: (vars) =>
    `Big shout from ${value(vars, 'claimer', 'someone')}. Anyone want to make them prove it?`,
  prove_ack: () => 'On it — checking the data.',
  clarify: (vars) => `One thing before we lock it in — ${value(vars, 'question')}`,
  counter_offer: (vars) =>
    `${value(vars, 'reason')} Your move: book it as stated (Oracle-resolved), or take the upgrade (Chain-proven).`,
  reject: (vars) => value(vars, 'message', "Can't put a number on that one — next shout."),
  confirm_gate: (vars) =>
    `Here's the call: ${value(vars, 'terms')}. Data says ${value(vars, 'probabilityPct')}%. ${value(vars, 'claimer')}, confirm this is your call. No offer goes live until you do.`,
  confirm_declined: () => 'No harm — the call stays banter.',
  no_price: () =>
    "Can't get a clean number on that right now — give it a moment and hit Run it again.",
  no_line: () =>
    "No line on this one yet — the numbers desk hasn't published for this match. Worth another go nearer kickoff.",
  unpriceable: () =>
    "Can't put a clean number on that one with the data I've got. If there's another option on the table, pick that — otherwise give me a different call.",
  already_decided: () =>
    "Data says that one's a done deal — no game in a sure thing. Pick a different option or give me a fresh call.",
  prove_retry: () => 'The data desk wobbled mid-check — tap "Run it back" and I\'ll price it again.',
  hiccup: () => 'Hiccup on my end — tap that one again.',
  hold_on: () => "Easy, legend — I'm already on it.",
  budget_spent: () => "I've done all the thinking I can in here for today — catch me tomorrow.",
  market_live: (vars) => `Locked in. ${value(vars, 'claimer')} is on the record — pick a side below.`,
  offer_live: (vars) =>
    `${value(vars, 'claimer', 'Someone')}'s call is on the board. Choose It happens · 0.01 SOL or It does not · 0.01 SOL below.`,
  offer_taken: () =>
    "Too late to pull it — there's already money on this one. It rides to the final whistle now.",
  pending_lineup_note: () =>
    'Held until lineups drop — if the name is on the sheet this goes live, otherwise all SOL comes back.',
  lineup_activated: () => 'Lineups are in — the call is live. Pick a side.',
  var_freeze: () => 'VAR check — calls locked. Nobody breathe.',
  calls_unlocked: () => "We're back — calls open again.",
  goal_alert: (vars) =>
    `GOAL — ${value(vars, 'scorer', 'unconfirmed scorer')} (${value(vars, 'minute', '?')}'). ${value(vars, 'note', 'Open calls are feeling it.')}`,
  settle_won: (vars) =>
    `CALLED IT. ${value(vars, 'claimer')} said it and the data backs it. ${value(vars, 'payouts', '')}`,
  settle_lost: (vars) =>
    `Not this time — the call goes down. ${value(vars, 'payouts', '')}`,
  void_market: (vars) =>
    `Call off — ${value(vars, 'reason', 'the match got away from us')}. Every SOL stake is back where it started.`,
  after_the_moment: (vars) =>
    `After the moment — no SOL moved. ${value(vars, 'names', 'Those taps')} came in once the pitch already knew; their SOL returned.`,
  positions_activated: () => 'Window cleared — those calls are locked in at their price.',
  pick_a_lane: () => "You can't back it and doubt it. Pick a lane.",
  insufficient_rep: (vars) =>
    `Not enough ${isMainnet(vars) ? 'SOL' : 'test SOL'} for that position. Available balance: ${value(vars, 'balance')} SOL. Open /deposit in private chat to add funds.`,
  cap_reached: (vars) =>
    `This call has reached the ${value(vars, 'cap')} SOL limit for one member. No position changed.`,
  stake_locked: (vars) =>
    `${value(vars, 'name')}'s position is recorded: ${value(vars, 'stake')} SOL on ${value(vars, 'side')}.`,
  stale: () => 'That ship has sailed.',
  not_your_shout: (vars) => `Only ${value(vars, 'claimer', 'the claimer')} can lock this one in.`,
  claimer_only_terms: (vars) => `The terms are ${value(vars, 'claimer', 'the claimer')}'s to pick.`,
  admin_only: () => "That's an admin move.",
  settings_intro: () => 'How chatty should I be in here?',
  settings_updated: (vars) => `Done — ${value(vars, 'summary')}.`,
  table_header: (vars) => `THE TABLE — ${value(vars, 'groupTitle', 'this group')}`,
  slate_intro: (vars) => `Morning, legends — today's card: ${value(vars, 'fixtures', 'check back soon')}`,
  replay_started: (vars) => isMainnet(vars)
    ? `TEST MATCH: ${value(vars, 'fixture')} is replaying at 20x speed. Send "${value(vars, 'p1', 'The first team')} will beat ${value(vars, 'p2', 'the second team')}", then reply /bookit. Positions use real mainnet SOL and require confirmation. Test results do not change Points.`
    : `TEST MATCH: ${value(vars, 'fixture')} is replaying at 20x speed. Send "${value(vars, 'p1', 'The first team')} will beat ${value(vars, 'p2', 'the second team')}", then reply /bookit. No test SOL moves and test results do not change Points.`,
  replay_finished: (vars) => isMainnet(vars)
    ? `TEST MATCH FINISHED: ${value(vars, 'fixture')}. Mainnet SOL positions were settled; Points did not change.`
    : `TEST MATCH FINISHED: ${value(vars, 'fixture')}. No test SOL moved and Points did not change.`,
  replay_blocked_live: (vars) => {
    const call = value(vars, 'call');
    if (call.length === 0) return 'Not while live calls are open in here — let those settle first.';
    return [
      'Test match blocked by this live call:',
      `“${call}”`,
      value(vars, 'resolution', 'Let it settle first.'),
    ].join('\n');
  },
  replay_blocking_call_voided: (vars) =>
    `Call voided: “${value(vars, 'call', 'the blocking call')}”. Run /testmatch again.`,
  replay_blocked_active: () => 'A test match is already running in this group.',
  replay_unknown_fixture: () => 'No completed match is available for a test run. Try /testmatch with a completed match ID.',
  replay_stopped: () => 'Test match stopped.',
  replay_failed: () => 'Test match stopped because its data could not be completed. Run /testmatch to try again.',
  replay_position_recorded: () => 'Test choice recorded. No starter position or test SOL was used.',
  replay_position_exists: () => 'Your test choice is already recorded. No starter position or test SOL was used.',
  bookit_needs_reply: () => 'Reply /bookit to the claim you want on the record.',
  window_closed: () => 'Too late for that one — the window is closed.',
  beta_access_required: () =>
    'Called It is in a limited beta and this group is not enabled yet. No call or SOL changed.',
  admin_permission_required: () =>
    'One step left: promote Called It to group admin with permission to manage messages. I will post the ready message when setup is complete.',
  group_ready: (vars) => isMainnet(vars)
    ? `Called It is ready on Solana mainnet. Say a football call, mention me, or reply /bookit to your own message. Choose one of two 0.01 SOL outcomes: "It happens" or "It does not." Choices and named results are visible to everyone in this group. Correct choices earn 10 points automatically. A verified wallet is required; /wallet in private chat shows your status. Board: ${value(vars, 'webUrl', 'the group board')}`
    : `Called It is ready. Say a football call, mention me, or reply /bookit to your own message. Each offer has two fixed 0.01 test-SOL choices: "It happens" or "It does not." Choices and named results are visible to everyone in this Telegram group. Correct choices earn 10 points automatically. Test SOL is devnet-only with no monetary value. Board: ${value(vars, 'webUrl', 'the group board')}`,
  private_start: () => 'Called It lives in group chats. Add it to a group to make a football call.',
  group_only_recovery: () => 'Open this command in the group where you want to use Called It.',
  points_unavailable: () => 'Points are temporarily unavailable. Try again shortly.',
  table_link: () => 'Open the group board.',
  detection_enabled: () =>
    "Always-on detection is live — big shouts get priced automatically. I'll keep the rest of the chat out of it.",
  detection_disabled: () =>
    'Always-on detection is off. Reply /bookit to any claim and I still work everywhere.',
};
