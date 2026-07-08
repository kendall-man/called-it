/**
 * Inline keyboard builders. All callback payloads go through the codec so
 * every button resolves to a DB row on tap.
 */

import { InlineKeyboard } from 'grammy';
import { TUNABLES } from '@calledit/market-engine';
import { encodeCallback } from './callbackData.js';
import type { Chattiness } from '../localTypes.js';
import type { Deps, MarketRow } from '../ports.js';

export function nudgeKeyboard(claimId: string): InlineKeyboard {
  return new InlineKeyboard().text('Make him prove it 🎯', encodeCallback({ t: 'prove', claimId }));
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

export function confirmKeyboard(claimId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("That's my shout ✅", encodeCallback({ t: 'confirm', claimId }))
    .row()
    .text('Not mine ❌', encodeCallback({ t: 'decline', claimId }));
}

export function stakeKeyboard(
  marketId: string,
  presetLabels?: readonly [string, string, string],
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  TUNABLES.PRESET_STAKES.forEach((amount, index) => {
    keyboard.text(`⚡ Back ${presetLabels?.[index] ?? amount}`, encodeCallback({ t: 'stake', marketId, side: 'back', presetIndex: index }));
  });
  keyboard.row();
  TUNABLES.PRESET_STAKES.forEach((amount, index) => {
    keyboard.text(`🛑 Doubt ${presetLabels?.[index] ?? amount}`, encodeCallback({ t: 'stake', marketId, side: 'doubt', presetIndex: index }));
  });
  return keyboard;
}

/**
 * Stake keyboard for a specific market row: sol markets get the wager
 * module's preset labels; every other market keeps the main-identical Rep
 * presets. Callback data encoding is unchanged in both cases.
 */
export function marketStakeKeyboard(deps: Deps, market: MarketRow): InlineKeyboard {
  const labels =
    market.currency === 'sol' ? deps.wager?.presetLabels() : undefined;
  return stakeKeyboard(market.id, labels);
}

export function settingsKeyboard(
  current: Chattiness,
  webEnabled: boolean,
  /** Only ever non-null when the wager module is live — flag-off keyboards are main-identical. */
  wagerState?: { enabled: boolean } | null,
): InlineKeyboard {
  const mark = (mode: Chattiness, label: string) => (current === mode ? `• ${label} •` : label);
  const keyboard = new InlineKeyboard()
    .text(mark('nudge', 'Priced nudges'), encodeCallback({ t: 'chattiness', mode: 'nudge' }))
    .row()
    .text(mark('react_only', 'React only 👀'), encodeCallback({ t: 'chattiness', mode: 'react_only' }))
    .row()
    .text(mark('trigger_only', 'Trigger only (/bookit)'), encodeCallback({ t: 'chattiness', mode: 'trigger_only' }))
    .row()
    .text(
      webEnabled ? 'Web pages: ON — tap to hide' : 'Web pages: OFF — tap to show',
      encodeCallback({ t: 'web', enabled: !webEnabled }),
    );
  if (wagerState) {
    keyboard
      .row()
      .text(
        wagerState.enabled
          ? 'Devnet SOL: ON — tap to switch off'
          : 'Devnet SOL: OFF — tap to switch on',
        encodeCallback({ t: 'wager', enabled: !wagerState.enabled }),
      );
  }
  return keyboard;
}
