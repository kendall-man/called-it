import type { Metadata } from 'next';
import { WalletRoute } from '@/components/wallet-route';

export const metadata: Metadata = {
  title: 'Wallet',
  description: 'Create and manage your Privy-protected Called It Solana wallet.',
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

export default function WalletSessionPage() {
  return <WalletRoute />;
}
