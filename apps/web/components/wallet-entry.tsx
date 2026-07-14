'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { RefreshCw } from 'lucide-react';
import type { WalletApplicationProps } from './wallet-application';
import { WalletButton, WalletState } from './wallet-ui';

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
  return (
    <WalletErrorBoundary>
      <WalletApplication {...props} />
    </WalletErrorBoundary>
  );
}

type WalletErrorBoundaryState = { readonly failed: boolean };

class WalletErrorBoundary extends Component<
  { readonly children: ReactNode },
  WalletErrorBoundaryState
> {
  state: WalletErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): WalletErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('wallet_client_exception', {
      name: error.name,
      message: error.message,
      componentStack: info.componentStack,
    });
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <WalletState
        title="Wallet needs attention"
        text="The wallet screen stopped unexpectedly. No SOL moved. Reload and try again."
        action={(
          <div className="mt-5">
            <WalletButton icon={<RefreshCw size={18} />} onClick={() => window.location.reload()}>
              Reload wallet
            </WalletButton>
          </div>
        )}
      />
    );
  }
}
