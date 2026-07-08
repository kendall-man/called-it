/**
 * Inline keyboard builders. All callback payloads go through the codec so
 * every button resolves to a DB row on tap.
 */

import { InlineKeyboard } from 'grammy';
import { encodeCallback } from './callbackData.js';
import type { Chattiness } from '../localTypes.js';
import type { Deps, MarketRow } from '../ports.js';

/** SOL amounts shown when the wager module can't be reached (it always can now). */
const DEFAULT_PRESET_LABELS: readonly [string, string, string] = ['0.01 SOL', '0.05 SOL', '0.1 SOL'];

/**
 * Single-button retry after an infrastructure blip during the parse: re-runs
 * the claim through the parser with no re-detection. Its `t:'prove'` guard
 * already accepts the 'nudged' status offerClaim leaves behind.
 */
export function retryParseKeyboard(claimId: string): InlineKeyboard {
  return new InlineKeyboard().text('Run it back 🔁', encodeCallback({ t: 'prove', claimId }));
}

export function optionsKeyboard(
  claimId: string,
  options: Array<{ key: string; label: string }>,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const option of options) {
    keyboard.text(option.label, encodeCallback({ t: 'option', claimId, key: option.key })).row();
  }
  return keyboard;
}

/**
 * Single-button retry after a pricing failure: re-quotes the STORED option
 * spec via the option handler — no fresh LLM parse, no dead keyboard.
 */
export function retryQuoteKeyboard(claimId: string, optionKey: string): InlineKeyboard {
  return new InlineKeyboard().text(
    'Run it again 🔁',
    encodeCallback({ t: 'option', claimId, key: optionKey }),
  );
}

/** Back / Bet-against rows with the three SOL preset amounts. */
export function stakeKeyboard(
  marketId: string,
  presetLabels: readonly [string, string, string],
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  presetLabels.forEach((label, index) => {
    keyboard.text(
      `⚡ Back ${label}`,
      encodeCallback({ t: 'stake', marketId, side: 'back', presetIndex: index }),
    );
  });
  keyboard.row();
  presetLabels.forEach((label, index) => {
    keyboard.text(
      `🛑 Against ${label}`,
      encodeCallback({ t: 'stake', marketId, side: 'doubt', presetIndex: index }),
    );
  });
  return keyboard;
}

/** Stake keyboard for a market row: labels come from the wager preset amounts. */
export function marketStakeKeyboard(deps: Deps, market: MarketRow): InlineKeyboard {
  const labels = deps.wager?.presetLabels() ?? DEFAULT_PRESET_LABELS;
  return stakeKeyboard(market.id, labels);
}

/** The offer card keyboard: both stake sides plus the claimer's "not mine" out. */
export function offerKeyboard(deps: Deps, market: MarketRow, claimId: string): InlineKeyboard {
  const keyboard = marketStakeKeyboard(deps, market);
  keyboard.row().text('Not mine ❌', encodeCallback({ t: 'decline', claimId }));
  return keyboard;
}

export function settingsKeyboard(current: Chattiness, webEnabled: boolean): InlineKeyboard {
  const mark = (mode: Chattiness, label: string) => (current === mode ? `• ${label} •` : label);
  return new InlineKeyboard()
    .text(mark('nudge', 'Auto-offer bets'), encodeCallback({ t: 'chattiness', mode: 'nudge' }))
    .row()
    .text(mark('react_only', 'React only 👀'), encodeCallback({ t: 'chattiness', mode: 'react_only' }))
    .row()
    .text(mark('trigger_only', 'Trigger only (/bookit)'), encodeCallback({ t: 'chattiness', mode: 'trigger_only' }))
    .row()
    .text(
      webEnabled ? 'Web pages: ON — tap to hide' : 'Web pages: OFF — tap to show',
      encodeCallback({ t: 'web', enabled: !webEnabled }),
    );
}
