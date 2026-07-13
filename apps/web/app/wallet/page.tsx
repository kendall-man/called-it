import type { Metadata } from 'next';
import { Badge, PageShell } from '@/components/ui';
import { WalletManager } from '@/components/wallet-manager';

export const metadata: Metadata = {
  title: 'Wallet',
  description: 'Create and manage your self-custody Called It Solana wallet.',
  robots: { index: false, follow: false },
};

export default function WalletPage() {
  const network = process.env.NEXT_PUBLIC_SOLANA_NETWORK === 'mainnet-beta'
    ? 'mainnet-beta'
    : 'devnet';
  return (
    <PageShell topRight={<Badge tone={network === 'mainnet-beta' ? 'flood' : 'sky'}>{network === 'mainnet-beta' ? 'Mainnet' : 'Devnet'}</Badge>}>
      <WalletManager
        network={network}
        rpcUrl="/api/solana/rpc"
        treasuryPubkey={process.env.NEXT_PUBLIC_WAGER_TREASURY_PUBKEY ?? ''}
      />
    </PageShell>
  );
}
