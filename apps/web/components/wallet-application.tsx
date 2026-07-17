'use client';

import { WalletManager } from './wallet-manager';
import { WalletProvider } from './wallet-provider';

export type WalletApplicationProps = {
  readonly appId: string;
  readonly network: 'devnet' | 'mainnet-beta';
  readonly rpcUrl: string;
  readonly treasuryPubkey: string;
  readonly botUsername: string;
  readonly custodyMode: 'legacy' | 'escrow';
  readonly escrowProgramId?: string;
  readonly canonicalUsdcMint?: string;
  readonly escrowGenesisHash?: string;
  readonly telegramInitData: string;
};

export function WalletApplication(props: WalletApplicationProps) {
  return (
    <WalletProvider appId={props.appId}>
      <WalletManager
        network={props.network}
        rpcUrl={props.rpcUrl}
        treasuryPubkey={props.treasuryPubkey}
        botUsername={props.botUsername}
        custodyMode={props.custodyMode}
        escrowProgramId={props.escrowProgramId}
        canonicalUsdcMint={props.canonicalUsdcMint}
        escrowGenesisHash={props.escrowGenesisHash}
        telegramInitData={props.telegramInitData}
      />
    </WalletProvider>
  );
}
