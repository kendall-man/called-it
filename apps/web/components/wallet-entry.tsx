'use client';

import dynamic from 'next/dynamic';
import type { WalletApplicationProps } from './wallet-application';
import { WalletState } from './wallet-ui';

const WalletApplication = dynamic(
  () => import('./wallet-application').then((module) => module.WalletApplication),
  {
    ssr: false,
    loading: () => (
      <WalletState
        title="Opening wallet"
        text="Loading secure wallet services..."
        loading
      />
    ),
  },
);

export function WalletEntry(props: WalletApplicationProps) {
  return <WalletApplication {...props} />;
}
