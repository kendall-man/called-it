export const PRIVY_WALLET_CLIENT_TYPES = ['privy'] as const;

export function isPrivyWalletClientType(value: unknown): value is typeof PRIVY_WALLET_CLIENT_TYPES[number] {
  return typeof value === 'string' && PRIVY_WALLET_CLIENT_TYPES.some((type) => type === value);
}

export type PrivySolanaWalletAccount = {
  readonly address: string;
  readonly chainType: 'solana';
  readonly type: 'wallet';
  readonly walletClientType: typeof PRIVY_WALLET_CLIENT_TYPES[number];
};

export function isPrivySolanaWalletAccount(value: unknown): value is PrivySolanaWalletAccount {
  if (typeof value !== 'object' || value === null) return false;
  return Reflect.get(value, 'type') === 'wallet' &&
    Reflect.get(value, 'chainType') === 'solana' &&
    typeof Reflect.get(value, 'address') === 'string' &&
    isPrivyWalletClientType(Reflect.get(value, 'walletClientType'));
}
