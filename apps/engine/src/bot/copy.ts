/**
 * All consumer-facing personality lines route through @calledit/agent
 * persona(). This module owns the template KEYS the engine uses plus a local
 * game-show-register fallback for each, used only if persona() itself throws
 * (e.g. unknown key during integration) — the bot must never go silent or
 * crash over copy.
 *
 * Register rules (compliance, asserted in copy.test.ts): no odds notation,
 * no bookie vocabulary, no currency symbols.
 */

import type { AgentPort } from '../ports.js';
import type { Logger } from '../log.js';

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
  | 'detection_enabled'
  | 'detection_disabled';

function v(vars: CopyVars, key: string, fallback = ''): string {
  const value = vars[key];
  return value === undefined ? fallback : String(value);
}

/**
 * Hand-written fallback bank, game-show register. These render only when the
 * agent package's persona() call fails; they must independently satisfy the
 * vocabulary deny-list.
 */
export const FALLBACK_TEMPLATES: Record<TemplateKey, (vars: CopyVars) => string> = {
  intro: (vars) =>
    `Evening, legends — I'm Called It. Make a football call by mentioning me or using /bookit on your own message. Once the speaker confirms, I price it from the live feed and post two choices in test SOL. Test SOL is a devnet token with no monetary value. Use /me for your private account and /table for the group board. Receipts live at ${v(vars, 'webUrl', 'the web link')}.`,
  help: () =>
    [
      'How this works:',
      '• Mention me with your call, or use /bookit on your own message. Passive calls wait for the speaker to confirm.',
      '• Choose It happens · 0.01 SOL or It does not · 0.01 SOL. Choose amount opens the larger test-SOL options.',
      '• I settle from the official feed and post an aggregate receipt.',
      '',
      'Private account: /me · Group board: /table',
      'Commands: /bookit (your own claim) · /settings (admins) · /table · /help',
      'Test SOL is a devnet token with no monetary value.',
    ].join('\n'),
  dm_start: (vars) =>
    `I live in group chats — add me to yours and the banter starts pricing itself. ${v(vars, 'addLink')}`,
  nudge_priced: (vars) =>
    `Big shout from ${v(vars, 'claimer', 'someone')}. Data says ${v(vars, 'probabilityPct')}% — anyone want to make them prove it?`,
  nudge_unpriced: (vars) =>
    `Big shout from ${v(vars, 'claimer', 'someone')}. Anyone want to make them prove it?`,
  prove_ack: () => 'On it — checking the data.',
  clarify: (vars) => `One thing before we lock it in — ${v(vars, 'question')}`,
  counter_offer: (vars) =>
    `${v(vars, 'reason')} Your move: book it as stated (Oracle-resolved), or take the upgrade (Chain-proven).`,
  reject: (vars) => v(vars, 'message', "Can't put a number on that one — next shout."),
  confirm_gate: (vars) =>
    `Here's the call: ${v(vars, 'terms')}. Data says ${v(vars, 'probabilityPct')}%. ${v(vars, 'claimer')}, confirm this is your call. No offer goes live until you do.`,
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
  market_live: (vars) => `Locked in. ${v(vars, 'claimer')} is on the record — pick a side below.`,
  offer_live: (vars) =>
    `${v(vars, 'claimer', 'Someone')}'s call is on the board. Choose It happens · 0.01 SOL or It does not · 0.01 SOL below.`,
  offer_taken: () =>
    "Too late to pull it — there's already money on this one. It rides to the final whistle now.",
  pending_lineup_note: () =>
    'Held until lineups drop — if the name is on the sheet this goes live, otherwise all SOL comes back.',
  lineup_activated: () => 'Lineups are in — the call is live. Pick a side.',
  var_freeze: () => 'VAR check — calls locked. Nobody breathe.',
  calls_unlocked: () => "We're back — calls open again.",
  goal_alert: (vars) =>
    `GOAL — ${v(vars, 'scorer', 'unconfirmed scorer')} (${v(vars, 'minute', '?')}'). ${v(vars, 'note', 'Open calls are feeling it.')}`,
  settle_won: (vars) =>
    `CALLED IT. ${v(vars, 'claimer')} said it and the data backs it. ${v(vars, 'payouts', '')}`,
  settle_lost: (vars) =>
    `Not this time — the call goes down. ${v(vars, 'payouts', '')}`,
  void_market: (vars) =>
    `Call off — ${v(vars, 'reason', 'the match got away from us')}. Every SOL stake is back where it started.`,
  after_the_moment: (vars) =>
    `After the moment — no SOL moved. ${v(vars, 'names', 'Those taps')} came in once the pitch already knew; their SOL returned.`,
  positions_activated: () => 'Window cleared — those calls are locked in at their price.',
  pick_a_lane: () => "You can't back it and doubt it. Pick a lane.",
  insufficient_rep: (vars) =>
    `Not enough test SOL for that position. Available balance: ${v(vars, 'balance')} SOL. Open /me for your private account.`,
  cap_reached: (vars) =>
    `This call has reached the ${v(vars, 'cap')} SOL limit for one member. No position changed.`,
  stake_locked: (vars) =>
    `${v(vars, 'name')}'s position is recorded: ${v(vars, 'stake')} SOL on ${v(vars, 'side')}.`,
  stale: () => 'That ship has sailed.',
  not_your_shout: (vars) => `Only ${v(vars, 'claimer', 'the claimer')} can lock this one in.`,
  claimer_only_terms: (vars) => `The terms are ${v(vars, 'claimer', 'the claimer')}'s to pick.`,
  admin_only: () => "That's an admin move.",
  settings_intro: () => 'How chatty should I be in here?',
  settings_updated: (vars) => `Done — ${v(vars, 'summary')}.`,
  table_header: (vars) => `THE TABLE — ${v(vars, 'groupTitle', 'this group')}`,
  slate_intro: (vars) => `Morning, legends — today's card: ${v(vars, 'fixtures', 'check back soon')}`,
  replay_started: (vars) =>
    `Internal fixture run active: ${v(vars, 'fixture')}. It is outside the direct onboarding path and group board.`,
  replay_finished: (vars) =>
    `Internal fixture run finished: ${v(vars, 'fixture')}. Any generated receipts remain internal compatibility records.`,
  replay_blocked_live: () => 'Not while live calls are open in here — let those settle first.',
  replay_blocked_active: () => 'An internal fixture run is already active for this group.',
  replay_unknown_fixture: () => "That fixture is unavailable. Open /table for current calls.",
  replay_stopped: () => 'Internal fixture run stopped.',
  bookit_needs_reply: () => 'Reply /bookit to the claim you want on the record.',
  window_closed: () => 'Too late for that one — the window is closed.',
  detection_enabled: () =>
    "Always-on detection is live — big shouts get priced automatically. I'll keep the rest of the chat out of it.",
  detection_disabled: () =>
    'Always-on detection is off. Reply /bookit to any claim and I still work everywhere.',
};

export type Say = (key: TemplateKey, vars?: CopyVars) => Promise<string>;

export function renderFallback(key: TemplateKey, vars: CopyVars = {}): string {
  return FALLBACK_TEMPLATES[key](vars);
}

/**
 * Bridge from engine copy keys to the @calledit/agent persona bank
 * (PERSONA_TEMPLATE_KEYS). The agent's templates leave unknown {placeholders}
 * verbatim, so a mapping only fires when every placeholder it needs is
 * present — otherwise we use the local fallback line.
 */
interface AgentMapping {
  agentKey: string;
  agentVars: CopyVars;
}

function has(vars: CopyVars, keys: string[]): boolean {
  return keys.every((key) => vars[key] !== undefined && String(vars[key]).length > 0);
}

const AGENT_TEMPLATE_MAP: Partial<Record<TemplateKey, (vars: CopyVars) => AgentMapping | null>> = {
  intro: () => ({ agentKey: 'intro_disclosure', agentVars: { botName: 'Called It' } }),
  nudge_priced: (vars) =>
    has(vars, ['claimer', 'quote', 'multiplier'])
      ? {
          agentKey: 'priced_nudge',
          agentVars: { claimer: v(vars, 'claimer'), quote: v(vars, 'quote'), multiplier: v(vars, 'multiplier') },
        }
      : null,
  clarify: (vars) =>
    has(vars, ['claimer', 'question'])
      ? {
          agentKey: 'clarify_question',
          agentVars: { claimer: v(vars, 'claimer'), question: v(vars, 'question') },
        }
      : null,
  counter_offer: (vars) =>
    has(vars, ['claimer', 'reason', 'offer'])
      ? {
          agentKey: 'counter_offer',
          agentVars: { claimer: v(vars, 'claimer'), reason: v(vars, 'reason'), offer: v(vars, 'offer') },
        }
      : null,
  confirm_gate: (vars) =>
    has(vars, ['claimer', 'terms', 'multiplier'])
      ? {
          agentKey: 'confirm_gate',
          agentVars: { claimer: v(vars, 'claimer'), terms: v(vars, 'terms'), multiplier: v(vars, 'multiplier') },
        }
      : null,
  stake_locked: (vars) =>
    has(vars, ['name', 'stake', 'multiplier', 'side'])
      ? {
          agentKey: v(vars, 'side') === 'Backing' ? 'back_ack' : 'doubt_ack',
          agentVars: { user: v(vars, 'name'), amount: v(vars, 'stake'), multiplier: v(vars, 'multiplier') },
        }
      : null,
  var_freeze: (vars) => ({
    agentKey: 'freeze',
    agentVars: { reason: 'VAR check', market: v(vars, 'market', 'this call') },
  }),
  calls_unlocked: (vars) => ({
    agentKey: 'unfreeze',
    agentVars: { market: v(vars, 'market', 'the call') },
  }),
  settle_won: (vars) =>
    has(vars, ['claimer', 'terms', 'payouts', 'url'])
      ? {
          agentKey: 'settlement_receipt_won',
          agentVars: {
            claimer: v(vars, 'claimer'),
            terms: v(vars, 'terms'),
            payouts: v(vars, 'payouts'),
            url: v(vars, 'url'),
          },
        }
      : null,
  settle_lost: (vars) =>
    has(vars, ['claimer', 'terms', 'payouts', 'url'])
      ? {
          agentKey: 'settlement_receipt_lost',
          agentVars: {
            claimer: v(vars, 'claimer'),
            terms: v(vars, 'terms'),
            payouts: v(vars, 'payouts'),
            url: v(vars, 'url'),
          },
        }
      : null,
  void_market: (vars) => ({
    agentKey: 'void_refund',
    agentVars: { reason: v(vars, 'reason', 'the match got away from us') },
  }),
  insufficient_rep: (vars) =>
    has(vars, ['user', 'balance'])
      ? {
          agentKey: 'insufficient_rep',
          agentVars: { user: v(vars, 'user'), balance: v(vars, 'balance') },
        }
      : null,
  pick_a_lane: (vars) =>
    has(vars, ['user']) ? { agentKey: 'pick_a_lane', agentVars: { user: v(vars, 'user') } } : null,
  slate_intro: (vars) =>
    has(vars, ['fixtures'])
      ? {
          agentKey: 'morning_slate',
          agentVars: { fixtures: v(vars, 'fixtures'), pending: v(vars, 'pending', ' ') },
        }
      : null,
  table_header: (vars) =>
    has(vars, ['groupTitle'])
      ? { agentKey: 'leaderboard_header', agentVars: { groupName: v(vars, 'groupTitle') } }
      : null,
};

export function createSay(agent: AgentPort, log: Logger): Say {
  return async (key, vars = {}) => {
    const mapping = AGENT_TEMPLATE_MAP[key]?.(vars) ?? null;
    if (mapping) {
      try {
        const line = await agent.persona(mapping.agentKey, mapping.agentVars);
        if (typeof line === 'string' && line.trim().length > 0) return line;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn('persona_fallback', { templateKey: key, error: message });
      }
    }
    return renderFallback(key, vars);
  };
}
