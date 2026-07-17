import { describe, expect, it } from 'vitest';
import {
  CustodyModeConfigurationError,
  parseWagerCustodyMode,
  readWagerCustodyMode,
} from './custody-mode.js';

describe('escrow custody mode', () => {
  it.each(['legacy', 'escrow'] as const)('accepts the explicit %s mode', (mode) => {
    expect(parseWagerCustodyMode(mode)).toBe(mode);
    expect(readWagerCustodyMode({ WAGER_CUSTODY_MODE: mode })).toBe(mode);
  });

  it.each([undefined, '', 'LEGACY', 'funded', ' escrow '])(
    'fails closed for an absent or unsupported mode: %s',
    (value) => {
      const parse = () => parseWagerCustodyMode(value);

      expect(parse).toThrow(CustodyModeConfigurationError);
      expect(parse).toThrow('Engine environment invalid: WAGER_CUSTODY_MODE');
    },
  );

  it('does not disclose the rejected configuration value', () => {
    const secretLikeValue = 'do-not-echo-this-value';

    expect(() => parseWagerCustodyMode(secretLikeValue)).toThrowError(
      'Engine environment invalid: WAGER_CUSTODY_MODE',
    );
  });
});
