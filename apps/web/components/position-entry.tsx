'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { RefreshCw } from 'lucide-react';
import type { PositionManagerProps } from './position-manager';
import { WalletButton, WalletState } from './wallet-ui';

const PositionApplication = dynamic(
  () => import('./position-application').then((module) => module.PositionApplication),
  {
    ssr: false,
    loading: () => (
      <WalletState title="Opening position" text="Loading secure wallet approval..." loading />
    ),
  },
);

export function PositionEntry(props: PositionManagerProps & { readonly appId: string }) {
  return (
    <PositionErrorBoundary>
      <PositionApplication {...props} />
    </PositionErrorBoundary>
  );
}
type PositionErrorBoundaryState = { readonly failed: boolean };

class PositionErrorBoundary extends Component<
  { readonly children: ReactNode },
  PositionErrorBoundaryState
> {
  state: PositionErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): PositionErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    console.error('position_client_exception');
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <WalletState
        title="Position needs attention"
        text="The approval screen stopped before confirmation. No new position was confirmed. Reload the secure link."
        action={(
          <div className="mt-5">
            <WalletButton icon={<RefreshCw size={18} />} onClick={() => window.location.reload()}>
              Reload approval
            </WalletButton>
          </div>
        )}
      />
    );
  }
}
