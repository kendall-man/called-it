export type CopyVars = Record<string, string | number>;

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
  | 'replay_blocked_active'
  | 'replay_unknown_fixture'
  | 'replay_stopped'
  | 'bookit_needs_reply'
  | 'window_closed'
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
  intro: (vars) =>
    `Evening, legends — I'm Called It. Make a football call by mentioning me or using /bookit on your own message. Once the speaker confirms, I price it from the live feed and post two choices in test SOL. Choices and named results are visible to everyone in this Telegram group. Correct choices earn 10 points automatically. Test SOL is a devnet token with no monetary value. Use /me for your private account and /table for the group board. Proof receipts live at ${value(vars, 'webUrl', 'the web link')}.`,
  help: () =>
    [
      'How this works:',
      '• Mention me with your call, or use /bookit on your own message. Passive calls wait for the speaker to confirm.',
      '• Choose It happens · 0.01 SOL or It does not · 0.01 SOL. Choose amount opens the larger test-SOL options.',
      '• Choices and named results are visible to everyone in this Telegram group.',
      '• Correct choices earn 10 points automatically.',
      '• I settle every result from the official feed and post a proof receipt.',
      '',
      'Private account: /me · Group board: /table',
      'Commands: /bookit · /leaderboard · /mystats · /table · /help',
      'Test SOL is a devnet token with no monetary value.',
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
    `Not enough test SOL for that position. Available balance: ${value(vars, 'balance')} SOL. Open /me for your private account.`,
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
  replay_started: (vars) =>
    `Internal fixture run active: ${value(vars, 'fixture')}. It is outside the direct onboarding path and group board.`,
  replay_finished: (vars) =>
    `Internal fixture run finished: ${value(vars, 'fixture')}. Any generated receipts remain internal compatibility records.`,
  replay_blocked_live: () => 'Not while live calls are open in here — let those settle first.',
  replay_blocked_active: () => 'An internal fixture run is already active for this group.',
  replay_unknown_fixture: () => "That fixture is unavailable. Open /table for current calls.",
  replay_stopped: () => 'Internal fixture run stopped.',
  bookit_needs_reply: () => 'Reply /bookit to the claim you want on the record.',
  window_closed: () => 'Too late for that one — the window is closed.',
  group_ready: (vars) =>
    `Called It is ready. Say a football call, mention me, or reply /bookit to your own message. Each offer has two fixed 0.01 test-SOL choices: "It happens" or "It does not." Choices and named results are visible to everyone in this Telegram group. Correct choices earn 10 points automatically. Test SOL is devnet-only with no monetary value. Board: ${value(vars, 'webUrl', 'the group board')}`,
  private_start: () => 'Called It lives in group chats. Add it to a group to make a football call.',
  group_only_recovery: () => 'Open this command in the group where you want to use Called It.',
  points_unavailable: () => 'Points are temporarily unavailable. Try again shortly.',
  table_link: () => 'Open the group board.',
  detection_enabled: () =>
    "Always-on detection is live — big shouts get priced automatically. I'll keep the rest of the chat out of it.",
  detection_disabled: () =>
    'Always-on detection is off. Reply /bookit to any claim and I still work everywhere.',
};
