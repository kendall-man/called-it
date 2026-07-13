'use client';

import { WalletManager } from './wallet-manager';
import { WalletProvider } from './wallet-provider';

export type WalletApplicationProps = {
  readonly appId: string;
  readonly clientId?: string;
  readonly network: 'devnet' | 'mainnet-beta';
  readonly rpcUrl: string;
  readonly treasuryPubkey: string;
};

export function WalletApplication(props: WalletApplicationProps) {
  return (
    <WalletProvider
      appId={props.appId}
      {...(props.clientId === undefined ? {} : { clientId: props.clientId })}
    >
      <WalletManager
        network={props.network}
        rpcUrl={props.rpcUrl}
        treasuryPubkey={props.treasuryPubkey}
      />
    </WalletProvider>
  );
}
