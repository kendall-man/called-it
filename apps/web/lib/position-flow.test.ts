import { describe, expect, it } from 'vitest';
import { positionFailure, positionStatusCopy } from './position-flow';

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
    expect(copy.action).toBe('refresh');
  });

  it('announces finality only after the indexed event is finalized', () => {
    expect(positionStatusCopy('confirming', null).text).toContain('Waiting for Solana finality');
    expect(positionStatusCopy('finalized', 'active').text).toContain('finalized');
  });
});
