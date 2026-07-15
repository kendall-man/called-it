export type PositionFailureAction = 'return' | 'retry' | 'refresh' | 'fund';

export const ESCROW_PUBLIC_ACTIVITY_NOTICE =
  'Wallet addresses, position amounts, and transaction history are public on Solana. Group members may connect this activity to your Telegram profile.';

export type PositionFailurePresentation = {
  readonly title: string;
  readonly text: string;
  readonly action: PositionFailureAction;
  readonly actionLabel: string;
};

export function positionFailure(code: string): PositionFailurePresentation {
  switch (code) {
    case 'session_expired':
    case 'expired_blockhash':
      return {
        title: 'Approval link expired',
        text: 'This approval window closed. No assets moved and no position was created. Return to Telegram and choose the position again.',
        action: 'return',
        actionLabel: 'Return to Telegram',
      };
    case 'market_frozen':
      return {
        title: 'Call is paused',
        text: 'The call changed while you were reviewing it. No assets moved and no position was created. Return to Telegram for the latest state.',
        action: 'return',
        actionLabel: 'Return to Telegram',
      };
    case 'market_closed':
    case 'session_consumed':
      return {
        title: 'Call is closed',
        text: 'This call no longer accepts positions. No assets moved in this attempt. Return to Telegram to choose another call.',
        action: 'return',
        actionLabel: 'Return to Telegram',
      };
    case 'quote_changed':
    case 'binding_mismatch':
    case 'asset_mismatch':
    case 'network_mismatch':
    case 'transaction_changed':
    case 'sponsor_signature_changed':
    case 'sponsor_signature_invalid':
      return {
        title: 'Position details changed',
        text: 'The network, price, asset, or call details no longer match. No assets moved and no position was created. Return to Telegram for a fresh approval.',
        action: 'return',
        actionLabel: 'Return to Telegram',
      };
    case 'insufficient_balance':
      return {
        title: 'Not enough balance',
        text: 'Your Privy wallet does not hold enough of this asset. No assets moved and no position was created. Return to Telegram and open /wallet to add funds.',
        action: 'return',
        actionLabel: 'Return to Telegram',
      };
    case 'telegram_auth_required':
      return {
        title: 'Open this approval in Telegram',
        text: 'This approval must open from your private Telegram chat. No assets moved and no position was created. Return to Telegram and tap Review and sign again.',
        action: 'return',
        actionLabel: 'Return to Telegram',
      };
    case 'privy_auth_required':
    case 'identity_mismatch':
      return {
        title: 'Wallet does not match',
        text: 'This approval link belongs to a different Telegram or Privy wallet. No assets moved and no position was created. Return to Telegram and open your own link.',
        action: 'return',
        actionLabel: 'Return to Telegram',
      };
    case 'unknown_confirmation':
      return {
        title: 'Confirmation is taking longer',
        text: 'The signed position was submitted, but its final result is not known yet. Do not approve it again. Refresh the status.',
        action: 'refresh',
        actionLabel: 'Refresh status',
      };
    case 'wallet_rejected':
    case 'cancelled':
      return {
        title: 'Approval cancelled',
        text: 'You cancelled the wallet approval. No assets moved and no position was created. Return to Telegram or retry this approval.',
        action: 'retry',
        actionLabel: 'Retry approval',
      };
    case 'on_chain_failure':
      return {
        title: 'Position failed on Solana',
        text: 'Solana rejected the position. The transfer was rolled back and no position exists. Return to Telegram for a fresh approval.',
        action: 'return',
        actionLabel: 'Return to Telegram',
      };
    case 'rpc_unavailable':
      return {
        title: 'Solana is unavailable',
        text: 'The call could not be checked safely. No assets moved and no position was created. Retry the check in a moment.',
        action: 'retry',
        actionLabel: 'Retry check',
      };
    default:
      return {
        title: 'Position unavailable',
        text: 'The secure position service could not finish this request. No new position was confirmed. Return to Telegram and try again.',
        action: 'return',
        actionLabel: 'Return to Telegram',
      };
  }
}

export function positionStatusCopy(
  stage: 'confirming' | 'finalized',
  state: 'pending' | 'active' | 'invalidated' | 'refundable' | 'claimed' | null,
): { readonly title: string; readonly text: string } {
  if (stage === 'confirming') {
    return {
      title: 'Recording position',
      text: 'Your wallet approved the exact position. Waiting for Solana finality before showing it as recorded.',
    };
  }
  if (state === 'pending') {
    return {
      title: 'Position recorded',
      text: 'Solana finalized this position. It is waiting through the in-play safety delay.',
    };
  }
  if (state === 'invalidated' || state === 'refundable') {
    return {
      title: 'Position recorded, then protected',
      text: 'Solana finalized the position, then marked it refundable after a live event changed the call.',
    };
  }
  if (state === 'claimed') {
    return {
      title: 'Position claimed',
      text: 'The finalized position has already paid or refunded your Privy wallet.',
    };
  }
  return {
    title: 'Position recorded',
    text: 'Solana finalized this position. It now appears in your escrow account.',
  };
}
