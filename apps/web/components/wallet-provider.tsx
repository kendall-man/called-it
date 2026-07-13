'use client';

import { PrivyProvider } from '@privy-io/react-auth';
import type { PrivyClientConfig } from '@privy-io/react-auth';
import type { ReactNode } from 'react';

type WalletProviderProps = {
  readonly appId: string;
  readonly clientId?: string;
  readonly children: ReactNode;
};

const PRIVY_CONFIG = {
  loginMethods: ['telegram'],
  appearance: {
    theme: 'dark',
    accentColor: '#31d17c',
    landingHeader: 'Open Called It Wallet',
    loginMessage: 'Continue with the Telegram account that opened this wallet.',
    walletChainType: 'solana-only',
  },
  embeddedWallets: {
    // WalletManager owns creation so authentication and creation cannot race.
    solana: { createOnLogin: 'off' },
    showWalletUIs: true,
  },
  externalWallets: {
    disableAllExternalWallets: true,
    walletConnect: { enabled: false },
  },
} satisfies PrivyClientConfig;

export function WalletProvider({ appId, clientId, children }: WalletProviderProps) {
  if (clientId === undefined) {
    return <PrivyProvider appId={appId} config={PRIVY_CONFIG}>{children}</PrivyProvider>;
  }
  return (
    <PrivyProvider appId={appId} clientId={clientId} config={PRIVY_CONFIG}>
      {children}
    </PrivyProvider>
  );
}
