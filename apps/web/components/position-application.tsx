'use client';

import { WalletProvider } from './wallet-provider';
import { PositionManager, type PositionManagerProps } from './position-manager';

export function PositionApplication(props: PositionManagerProps & { readonly appId: string }) {
  return (
    <WalletProvider appId={props.appId} landingHeader="Approve Called It position">
      <PositionManager {...props} />
    </WalletProvider>
  );
}
