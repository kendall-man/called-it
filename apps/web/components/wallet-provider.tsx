'use client';

import { PrivyProvider } from '@privy-io/react-auth';
import type { PrivyClientConfig } from '@privy-io/react-auth';
import type { ReactNode } from 'react';

type WalletProviderProps = {
  readonly appId: string;
  readonly children: ReactNode;
  readonly landingHeader?: string;
};

const PRIVY_CONFIG = {
  appearance: {
    theme: 'dark',
    accentColor: '#31d17c',
    landingHeader: 'Open Rumble Wallet',
    walletChainType: 'solana-only',
  },
  embeddedWallets: {
    solana: { createOnLogin: 'users-without-wallets' },
    showWalletUIs: false,
  },
  externalWallets: {
    walletConnect: { enabled: false },
  },
} satisfies PrivyClientConfig;

export function WalletProvider({ appId, children, landingHeader }: WalletProviderProps) {
  return (
    <PrivyProvider
      appId={appId}
      config={{
        ...PRIVY_CONFIG,
        appearance: {
          ...PRIVY_CONFIG.appearance,
          landingHeader: landingHeader ?? PRIVY_CONFIG.appearance.landingHeader,
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
