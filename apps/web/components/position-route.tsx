import { Badge, PageShell } from '@/components/ui';
import { PositionEntry } from './position-entry';
import { WalletState } from './wallet-ui';

export function PositionRoute(props: { readonly token: string }) {
  const network = process.env.NEXT_PUBLIC_SOLANA_NETWORK === 'mainnet-beta'
    ? 'mainnet-beta'
    : 'devnet';
  const custodyMode = process.env.NEXT_PUBLIC_WAGER_CUSTODY_MODE === 'escrow'
    ? 'escrow'
    : 'legacy';
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const programId = process.env.NEXT_PUBLIC_ESCROW_PROGRAM_ID;
  const canonicalUsdcMint = process.env.NEXT_PUBLIC_ESCROW_CANONICAL_USDC_MINT;
  const configured = custodyMode === 'escrow' && appId !== undefined &&
    programId !== undefined && canonicalUsdcMint !== undefined;
  return (
    <PageShell topRight={(
      <Badge tone={network === 'mainnet-beta' ? 'flood' : 'sky'}>
        {network === 'mainnet-beta' ? 'Mainnet · real assets' : 'Devnet · test assets'}
      </Badge>
    )}>
      {!configured ? (
        <WalletState
          title="Position unavailable"
          text="Secure escrow approval is not enabled. No assets moved. Return to Telegram."
          action={process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME ? (
            <a
              className="mt-5 flex min-h-12 w-full items-center justify-center rounded-lg bg-pitch-400 px-4 text-sm font-bold text-night-950 hover:bg-pitch-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pitch-300"
              href={`https://t.me/${encodeURIComponent(process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME)}`}
            >
              Return to Telegram
            </a>
          ) : undefined}
        />
      ) : (
        <PositionEntry
          appId={appId}
          botUsername={process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME ?? ''}
          canonicalUsdcMint={canonicalUsdcMint}
          network={network}
          programId={programId}
          rpcUrl="/api/solana/rpc"
          token={props.token}
        />
      )}
    </PageShell>
  );
}
