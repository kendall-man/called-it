export const WAGER_CUSTODY_MODES = ['legacy', 'escrow'] as const;

export type WagerCustodyMode = (typeof WAGER_CUSTODY_MODES)[number];

export class CustodyModeConfigurationError extends Error {
  readonly name = 'CustodyModeConfigurationError';

  constructor() {
    super('Engine environment invalid: WAGER_CUSTODY_MODE');
  }
}

export function parseWagerCustodyMode(value: string | undefined): WagerCustodyMode {
  if (value === 'legacy' || value === 'escrow') return value;
  throw new CustodyModeConfigurationError();
}

export function readWagerCustodyMode(source: {
  readonly WAGER_CUSTODY_MODE?: string | undefined;
}): WagerCustodyMode {
  return parseWagerCustodyMode(source.WAGER_CUSTODY_MODE);
}
