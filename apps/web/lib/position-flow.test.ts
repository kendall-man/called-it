import { describe, expect, it } from 'vitest';
import {
  ESCROW_PUBLIC_ACTIVITY_NOTICE,
  positionFailure,
  positionStatusCopy,
} from './position-flow';

describe('position recovery copy', () => {
  it.each([
    'session_expired',
    'market_frozen',
    'quote_changed',
    'insufficient_balance',
    'identity_mismatch',
    'rpc_unavailable',
    'wallet_rejected',
    'on_chain_failure',
  ])('states asset and position impact for %s', (code) => {
    const copy = positionFailure(code);
    expect(copy.text).toMatch(/assets moved|transfer was rolled back/i);
    expect(copy.actionLabel.length).toBeGreaterThan(0);
  });

  it('does not tell an unknown-confirmation user to sign again', () => {
    const copy = positionFailure('unknown_confirmation');
    expect(copy.text).toContain('Do not approve it again');
    expect(copy.action).toBe('status');
  });

  it('discloses public wallet activity before approval', () => {
    expect(ESCROW_PUBLIC_ACTIVITY_NOTICE).toContain('public on Solana');
    expect(ESCROW_PUBLIC_ACTIVITY_NOTICE).toContain('Telegram profile');
  });

  it('tells an external-browser user to reopen the approval inside Telegram', () => {
    expect(positionFailure('telegram_auth_required')).toEqual({
      title: 'Open this approval in Telegram',
      text: 'This approval must open from your private Telegram chat. No assets moved and no position was created. Return to Telegram and tap Review and sign again.',
      action: 'return',
      actionLabel: 'Return to Telegram',
    });
  });

  it('announces finality only after the indexed event is finalized', () => {
    expect(positionStatusCopy('confirming', null).text).toContain('Waiting for Solana finality');
    expect(positionStatusCopy('finalized', 'active').text).toContain('finalized');
  });
});
