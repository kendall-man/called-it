'use client';

import { PrivyProvider } from '@privy-io/react-auth';
import type { PrivyClientConfig } from '@privy-io/react-auth';
import type { ReactNode } from 'react';

type WalletProviderProps = {
  readonly appId: string;
  readonly children: ReactNode;
};

const PRIVY_CONFIG = {
  appearance: {
    theme: 'dark',
    accentColor: '#31d17c',
    landingHeader: 'Open Called It Wallet',
    walletChainType: 'solana-only',
  },
  embeddedWallets: {
    solana: { createOnLogin: 'users-without-wallets' },
    showWalletUIs: true,
  },
  externalWallets: {
    walletConnect: { enabled: false },
  },
} satisfies PrivyClientConfig;

export function WalletProvider({ appId, children }: WalletProviderProps) {
  return <PrivyProvider appId={appId} config={PRIVY_CONFIG}>{children}</PrivyProvider>;
}
