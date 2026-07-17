import { describe, expect, it } from 'vitest';
import { miniAppOpenFailure } from './miniapp-flow';

const KNOWN_CODES = [
  'market_not_found',
  'market_closed',
  'positions_paused',
  'rate_limited',
  'invalid_request',
  'telegram_auth_required',
  'sponsor_unavailable',
] as const;

describe('Mini App open failure copy', () => {
  it('states what happened, that no SOL moved, and one next action for every code', () => {
    for (const code of KNOWN_CODES) {
      for (const surface of ['position', 'wallet'] as const) {
        const failure = miniAppOpenFailure(code, surface);
        expect(failure.title.length, code).toBeGreaterThan(0);
        expect(failure.text, code).toContain('No SOL moved');
        expect(failure.actionLabel.length, code).toBeGreaterThan(0);
        expect(['retry', 'close']).toContain(failure.action);
        expect(failure.text, code).not.toContain('—');
        expect(failure.title, code).not.toContain('—');
      }
    }
  });

  it('offers a retry only for transient conditions', () => {
    expect(miniAppOpenFailure('positions_paused', 'position').action).toBe('retry');
    expect(miniAppOpenFailure('rate_limited', 'position').action).toBe('retry');
    expect(miniAppOpenFailure('sponsor_unavailable', 'position').action).toBe('retry');
    expect(miniAppOpenFailure('market_closed', 'position').action).toBe('close');
    expect(miniAppOpenFailure('market_not_found', 'position').action).toBe('close');
    expect(miniAppOpenFailure('invalid_request', 'position').action).toBe('close');
  });

  it('describes the wallet surface in wallet terms for unknown codes', () => {
    const wallet = miniAppOpenFailure('unexpected_code', 'wallet');
    const position = miniAppOpenFailure('unexpected_code', 'position');
    expect(wallet.text).toContain('wallet');
    expect(wallet.text).not.toBe(position.text);
    expect(position.text).toContain('position');
  });
});
