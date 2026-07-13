export const SOLANA_NETWORKS = ['devnet', 'mainnet-beta'] as const;

export type SolanaNetwork = (typeof SOLANA_NETWORKS)[number];

const GENESIS_HASHES: Readonly<Record<SolanaNetwork, string>> = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};

export function expectedGenesisHash(network: SolanaNetwork): string {
  return GENESIS_HASHES[network];
}

export function explorerTxUrlForNetwork(txSig: string, network: SolanaNetwork): string {
  const base = `https://explorer.solana.com/tx/${txSig}`;
  return network === 'devnet' ? `${base}?cluster=devnet` : base;
}

export function rpcUrlLooksLikeDevnet(rpcUrl: string): boolean {
  const url = new URL(rpcUrl);
  return /(?:^|[.\-_/?=&])devnet(?:[.\-_/?=&]|$)/i.test(`${url.hostname}${url.pathname}${url.search}`);
}
