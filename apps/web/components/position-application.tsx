'use client';

import { WalletProvider } from './wallet-provider';
import { PositionManager, type PositionManagerProps } from './position-manager';

export function PositionApplication(props: PositionManagerProps & { readonly appId: string }) {
  return (
    <WalletProvider appId={props.appId} landingHeader="Confirm your Rumble pick">
      <PositionManager {...props} />
    </WalletProvider>
  );
}
