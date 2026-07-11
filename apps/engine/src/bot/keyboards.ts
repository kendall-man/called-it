/**
 * Inline keyboard builders. All callback payloads go through the codec so
 * every button resolves to a DB row on tap.
 */

import { InlineKeyboard } from 'grammy';
import { encodeCallback } from './callbackData.js';
import type { Chattiness } from '../localTypes.js';
import type { Deps, MarketRow } from '../ports.js';

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

/** Only the original speaker may use this gate; callbacks enforce ownership. */
export function confirmKeyboard(claimId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('Confirm', encodeCallback({ t: 'confirm', claimId }))
    .text('Decline', encodeCallback({ t: 'decline', claimId }));
}

/** The beta exposes exactly the two fixed 0.01 SOL choices. */
export function offerKeyboard(market: MarketRow): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      'It happens · 0.01 SOL',
      encodeCallback({ t: 'stake', marketId: market.id, side: 'back', presetIndex: 0 }),
    )
    .row()
    .text(
      'It does not · 0.01 SOL',
      encodeCallback({ t: 'stake', marketId: market.id, side: 'doubt', presetIndex: 0 }),
    );
}

/** A refresh preserves the same two-action public offer contract. */
export function marketStakeKeyboard(_deps: Deps, market: MarketRow): InlineKeyboard {
  return offerKeyboard(market);
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
