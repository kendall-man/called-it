export type PublicSolanaNetwork = 'devnet' | 'mainnet-beta';

export function publicSolanaNetwork(
  value = process.env.NEXT_PUBLIC_SOLANA_NETWORK,
): PublicSolanaNetwork {
  return value === 'mainnet-beta' ? 'mainnet-beta' : 'devnet';
}

export function isMainnet(value = process.env.NEXT_PUBLIC_SOLANA_NETWORK): boolean {
  return publicSolanaNetwork(value) === 'mainnet-beta';
}
