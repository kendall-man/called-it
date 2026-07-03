/**
 * Inline keyboard builders. All callback payloads go through the codec so
 * every button resolves to a DB row on tap.
 */

import { InlineKeyboard } from 'grammy';
import { TUNABLES } from '@calledit/market-engine';
import { encodeCallback } from './callbackData.js';
import type { Chattiness } from '../localTypes.js';

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

export function confirmKeyboard(claimId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("That's my shout ✅", encodeCallback({ t: 'confirm', claimId }))
    .row()
    .text('Not mine ❌', encodeCallback({ t: 'decline', claimId }));
}

export function stakeKeyboard(marketId: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  TUNABLES.PRESET_STAKES.forEach((amount, index) => {
    keyboard.text(`⚡ Back ${amount}`, encodeCallback({ t: 'stake', marketId, side: 'back', presetIndex: index }));
  });
  keyboard.row();
  TUNABLES.PRESET_STAKES.forEach((amount, index) => {
    keyboard.text(`🛑 Doubt ${amount}`, encodeCallback({ t: 'stake', marketId, side: 'doubt', presetIndex: index }));
  });
  return keyboard;
}

export function settingsKeyboard(current: Chattiness, webEnabled: boolean): InlineKeyboard {
  const mark = (mode: Chattiness, label: string) => (current === mode ? `• ${label} •` : label);
  return new InlineKeyboard()
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
}
