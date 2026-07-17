export type MiniAppOpenSurface = 'position' | 'wallet';

export type MiniAppOpenFailure = {
  readonly title: string;
  readonly text: string;
  readonly action: 'retry' | 'close';
  readonly actionLabel: string;
};

/**
 * Failure copy for the Mini App open step (before any wallet or signing UI).
 * Every entry follows the three-part pattern: what happened, whether SOL or
 * saved state changed, one next action.
 */
export function miniAppOpenFailure(
  code: string,
  surface: MiniAppOpenSurface,
): MiniAppOpenFailure {
  switch (code) {
    case 'market_not_found':
      return {
        title: 'Call not found',
        text: 'This call is no longer available. No SOL moved and no position was created. Close this screen and pick a call from the group chat.',
        action: 'close',
        actionLabel: 'Close',
      };
    case 'market_closed':
      return {
        title: 'Call is closed',
        text: 'This call no longer accepts positions. No SOL moved and no position was created. Close this screen and pick another call in the group chat.',
        action: 'close',
        actionLabel: 'Close',
      };
    case 'positions_paused':
      return {
        title: 'Positions are paused',
        text: 'This call is getting ready and is not taking positions yet. No SOL moved and no position was created. Try again in a moment.',
        action: 'retry',
        actionLabel: 'Try again',
      };
    case 'rate_limited':
      return {
        title: 'Too many attempts',
        text: 'This screen was opened too many times in a short period. No SOL moved and nothing changed. Wait a moment, then try again.',
        action: 'retry',
        actionLabel: 'Try again',
      };
    case 'invalid_request':
      return {
        title: 'This link did not work',
        text: 'The button sent a link that could not be read. No SOL moved and nothing changed. Close this screen and tap the button on the card again.',
        action: 'close',
        actionLabel: 'Close',
      };
    case 'telegram_auth_required':
      return {
        title: 'Open this in Telegram',
        text: 'Your Telegram session could not be verified. No SOL moved and nothing changed. Close this screen and tap the button on the card again.',
        action: 'close',
        actionLabel: 'Close',
      };
    default:
      return surface === 'wallet'
        ? {
          title: 'Could not open the wallet',
          text: 'The service could not prepare your wallet link. No SOL moved and your wallet did not change. Try again in a moment.',
          action: 'retry',
          actionLabel: 'Try again',
        }
        : {
          title: 'Could not open this call',
          text: 'The service could not prepare this position. No SOL moved and no position was created. Try again in a moment.',
          action: 'retry',
          actionLabel: 'Try again',
        };
  }
}
