/**
 * Inline keyboard builders. All callback payloads go through the codec so
 * every button resolves to a DB row on tap.
 */

import { InlineKeyboard } from 'grammy';
import { encodeCallback } from './callbackData.js';
import { sideLabels } from './cards.js';
import type { Chattiness } from '../localTypes.js';
import type { Deps, MarketRow } from '../ports.js';

/**
 * Direct-link Mini App signing URLs (shared startapp contract with apps/web):
 * available only when custody is escrow, TELEGRAM_MINIAPP_SHORT_NAME is
 * configured, and the runtime bot identity is known. The offer card's side
 * buttons are callback-only; these URLs are reserved for the staking value
 * step (follow-up wave), so the contract and its config stay wired.
 */
export interface MiniAppOfferKeyboardConfig {
  readonly custodyMode: 'legacy' | 'escrow';
  /** BotFather /newapp short name; undefined keeps the flag off. */
  readonly miniAppShortName: string | undefined;
  /** Runtime bot identity; undefined until grammY init resolves getMe. */
  readonly botUsername: () => string | undefined;
}

let miniAppOfferConfig: MiniAppOfferKeyboardConfig | null = null;

/** Startup wiring hook; pass null to reset (tests). */
export function configureMiniAppOfferKeyboards(
  config: MiniAppOfferKeyboardConfig | null,
): void {
  miniAppOfferConfig = config;
}

const MINIAPP_MARKET_ID_HEX_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Shared contract with apps/web: "p-<marketId as 32 lowercase hex chars>-<b|d>"
 * (b backs the call, d goes against). Carries no secret — the Mini App mints
 * its session against verified initData, never from this param.
 */
export function miniAppStartParam(marketId: string, side: 'back' | 'doubt'): string | null {
  const hex = marketId.toLowerCase().replaceAll('-', '');
  if (!MINIAPP_MARKET_ID_HEX_PATTERN.test(hex)) return null;
  return `p-${hex}-${side === 'back' ? 'b' : 'd'}`;
}

export function miniAppPositionUrl(market: MarketRow, side: 'back' | 'doubt'): string | null {
  const config = miniAppOfferConfig;
  if (config === null || config.custodyMode !== 'escrow' || config.miniAppShortName === undefined) {
    return null;
  }
  const username = config.botUsername();
  if (username === undefined || username.length === 0) return null;
  const param = miniAppStartParam(market.id, side);
  if (param === null) return null;
  return `https://t.me/${username}/${config.miniAppShortName}?startapp=${param}`;
}

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

/**
 * The two side actions, labeled by the deterministic per-claim templates from
 * the compiled spec (binary "It happens" / "It does not" fallback). Amounts
 * live on the card body, not in the button label; both buttons are callback
 * buttons so the side tap stays inside the chat.
 */
export function offerKeyboard(market: MarketRow): InlineKeyboard {
  const sides = sideLabels(market.spec);
  return new InlineKeyboard()
    .text(
      sides.back,
      encodeCallback({ t: 'stake', marketId: market.id, side: 'back', presetIndex: 0 }),
    )
    .row()
    .text(
      sides.doubt,
      encodeCallback({ t: 'stake', marketId: market.id, side: 'doubt', presetIndex: 0 }),
    );
}

export function stakeConfirmationKeyboard(intentId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('Confirm', encodeCallback({ t: 'stake_confirm', intentId }))
    .text('Cancel', encodeCallback({ t: 'stake_cancel', intentId }));
}

export function voidReplayBlockerKeyboard(marketId: string): InlineKeyboard {
  return new InlineKeyboard().text(
    'Void call',
    encodeCallback({ t: 'void_replay_blocker', marketId }),
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
