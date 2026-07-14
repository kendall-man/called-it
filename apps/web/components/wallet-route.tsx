import { Badge, PageShell } from '@/components/ui';
import { WalletEntry } from '@/components/wallet-entry';
import { WalletState } from '@/components/wallet-ui';

export function WalletRoute() {
  const network = process.env.NEXT_PUBLIC_SOLANA_NETWORK === 'mainnet-beta'
    ? 'mainnet-beta'
    : 'devnet';
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const custodyMode = process.env.NEXT_PUBLIC_WAGER_CUSTODY_MODE === 'escrow'
    ? 'escrow'
    : 'legacy';
  return (
    <PageShell topRight={<Badge tone={network === 'mainnet-beta' ? 'flood' : 'sky'}>{network === 'mainnet-beta' ? 'Mainnet' : 'Devnet'}</Badge>}>
      {appId === undefined || appId.length === 0 ? (
        <WalletState title="Wallet unavailable" text="Secure wallet configuration is incomplete. No SOL moved." />
      ) : (
        <WalletEntry
          appId={appId}
          network={network}
          rpcUrl="/api/solana/rpc"
          treasuryPubkey={process.env.NEXT_PUBLIC_WAGER_TREASURY_PUBKEY ?? ''}
          botUsername={process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME ?? ''}
          custodyMode={custodyMode}
          canonicalUsdcMint={process.env.NEXT_PUBLIC_ESCROW_CANONICAL_USDC_MINT}
        />
      )}
    </PageShell>
  );
}
