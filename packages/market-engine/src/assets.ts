export const WAGER_ASSETS = ['sol', 'usdc'] as const;

export type WagerAsset = (typeof WAGER_ASSETS)[number];
export type MarketCurrency = 'rep' | WagerAsset;

export interface WagerAssetDefinition {
  readonly asset: WagerAsset;
  readonly code: 'SOL' | 'USDC';
  readonly decimals: 9 | 6;
  readonly atomicUnitsPerToken: bigint;
}

export const WAGER_ASSET_DEFINITIONS: Readonly<Record<WagerAsset, WagerAssetDefinition>> = {
  sol: {
    asset: 'sol',
    code: 'SOL',
    decimals: 9,
    atomicUnitsPerToken: 1_000_000_000n,
  },
  usdc: {
    asset: 'usdc',
    code: 'USDC',
    decimals: 6,
    atomicUnitsPerToken: 1_000_000n,
  },
};

export function isWagerAsset(value: unknown): value is WagerAsset {
  return value === 'sol' || value === 'usdc';
}

export function formatAtomicAmount(amountAtomic: bigint, asset: WagerAsset): string {
  const definition = WAGER_ASSET_DEFINITIONS[asset];
  const negative = amountAtomic < 0n;
  const magnitude = negative ? -amountAtomic : amountAtomic;
  const whole = magnitude / definition.atomicUnitsPerToken;
  const fraction = magnitude % definition.atomicUnitsPerToken;
  const fractionText = fraction
    .toString()
    .padStart(definition.decimals, '0')
    .replace(/0+$/, '');
  const body = fractionText.length === 0 ? whole.toString() : `${whole}.${fractionText}`;
  return negative ? `-${body}` : body;
}

export function formatWagerAmount(amountAtomic: bigint, asset: WagerAsset): string {
  return `${formatAtomicAmount(amountAtomic, asset)} ${WAGER_ASSET_DEFINITIONS[asset].code}`;
}

export function parseAtomicAmount(value: string, asset: WagerAsset): bigint | null {
  const definition = WAGER_ASSET_DEFINITIONS[asset];
  const match = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const fraction = match[1] ?? '';
  if (fraction.length > definition.decimals) return null;
  const [whole = '0'] = value.trim().split('.');
  const amount = BigInt(whole) * definition.atomicUnitsPerToken
    + BigInt(fraction.padEnd(definition.decimals, '0') || '0');
  return amount;
}
