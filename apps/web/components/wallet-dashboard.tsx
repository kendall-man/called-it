'use client';

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { PublicKey } from '@solana/web3.js';
import { usePrivy } from '@privy-io/react-auth';
import { useExportWallet } from '@privy-io/react-auth/solana';
import { Download, KeyRound, LoaderCircle, RefreshCw, Send, ShieldCheck, WalletCards } from 'lucide-react';
import { Card } from '@/components/ui';
import {
  explorerTransactionUrl,
  formatWalletAmount,
  minimumWalletTransfer,
  parseWalletAmount,
  sendWalletTransfer,
  walletBalances,
  type WalletAsset,
} from '@/lib/wallet-transfers';
import {
  requestWalletAccount,
  type WalletAccountSummary,
} from '@/lib/wallet-client';
import { requestEscrowAccountPositions } from '@/lib/position-client';
import type { EscrowAccountPosition } from '@/lib/position-contract';
import {
  WalletButton,
  WalletHeading,
  WalletStatus,
  WalletValue,
  walletInputClass,
} from './wallet-ui';

type WalletDashboardProps = {
  readonly network: 'devnet' | 'mainnet-beta';
  readonly rpcUrl: string;
  readonly treasuryPubkey: string;
  readonly address: string;
  readonly custodyMode: 'legacy' | 'escrow';
  readonly canonicalUsdcMint?: string;
  readonly signTransaction: (transaction: Uint8Array) => Promise<Uint8Array>;
};

export function WalletDashboard(props: WalletDashboardProps) {
  const { user, getAccessToken, linkEmail, linkPasskey } = usePrivy();
  const { exportWallet } = useExportWallet();
  const [balances, setBalances] = useState<Readonly<Record<WalletAsset, bigint>> | null>(null);
  const [account, setAccount] = useState<WalletAccountSummary | null>(null);
  const [escrowPositions, setEscrowPositions] = useState<readonly EscrowAccountPosition[] | null>(null);
  const [accountError, setAccountError] = useState('');
  const [amount, setAmount] = useState('0.01');
  const [asset, setAsset] = useState<WalletAsset>('sol');
  const [mode, setMode] = useState<'deposit' | 'send'>('deposit');
  const [destination, setDestination] = useState('');
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState(props.custodyMode === 'escrow'
    ? 'Wallet verified. Your assets stay in this Privy wallet until you approve one exact position.'
    : 'Wallet verified. Add SOL or USDC, then deposit it into Called It.');
  const [error, setError] = useState('');
  const [signature, setSignature] = useState('');
  const hasEmail = user?.linkedAccounts.some((account) => account.type === 'email') ?? false;
  const hasPasskey = user?.linkedAccounts.some((account) => account.type === 'passkey') ?? false;

  const refreshBalance = useCallback(async () => {
    try {
      setBalances(await walletBalances(
        props.rpcUrl,
        new PublicKey(props.address),
        props.network,
        props.custodyMode === 'escrow' ? props.canonicalUsdcMint : undefined,
      ));
    } catch {
      setNotice('Balance could not refresh. Try again shortly.');
    }
  }, [props.address, props.canonicalUsdcMint, props.custodyMode, props.network, props.rpcUrl]);

  const refreshAccount = useCallback(async (): Promise<WalletAccountSummary> => {
    try {
      const accessToken = await getAccessToken();
      if (accessToken === null) throw new Error('wallet session unavailable');
      const summary = await requestWalletAccount(accessToken, props.address);
      setAccount(summary);
      setAccountError('');
      return summary;
    } catch (cause) {
      setAccountError('Called It balance could not refresh. Try again shortly.');
      throw cause;
    }
  }, [getAccessToken, props.address]);

  const refreshEscrowPositions = useCallback(async () => {
    try {
      const accessToken = await getAccessToken();
      if (accessToken === null) throw new Error('wallet session unavailable');
      const positions = await requestEscrowAccountPositions(accessToken, props.address);
      setEscrowPositions(positions);
      setAccountError('');
    } catch (cause) {
      setAccountError('Escrow positions could not refresh. Your on-chain wallet balance is unchanged. Try again.');
      throw cause;
    }
  }, [getAccessToken, props.address]);

  useEffect(() => {
    void refreshBalance();
    if (props.custodyMode === 'escrow') {
      void refreshEscrowPositions().catch(() => undefined);
    } else {
      void refreshAccount().catch(() => undefined);
    }
    const interval = window.setInterval(() => {
      if (props.custodyMode === 'escrow') {
        void refreshEscrowPositions().catch(() => undefined);
      } else {
        void refreshAccount().catch(() => undefined);
      }
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [props.custodyMode, refreshAccount, refreshBalance, refreshEscrowPositions]);

  const watchForDepositCredit = useCallback(async (
    selectedAsset: WalletAsset,
    previousAvailable: bigint | null,
  ) => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 5_000));
      try {
        const summary = await refreshAccount();
        if (
          previousAvailable === null
          || summary.balances[selectedAsset].availableAtomic > previousAvailable
        ) {
          setNotice('Deposit credited. Your Called It balance is ready to use.');
          return;
        }
      } catch {
        // The regular refresh state already explains a temporary read failure.
      }
    }
    setNotice('Deposit confirmed on-chain and is still being credited. Refresh in a moment.');
  }, [refreshAccount]);

  async function copyAddress() {
    await navigator.clipboard.writeText(props.address);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  async function submitTransfer(event: FormEvent) {
    event.preventDefault();
    const amountAtomic = parseWalletAmount(amount, asset);
    if (amountAtomic === null || amountAtomic < minimumWalletTransfer(asset)) {
      setError(asset === 'sol' ? 'Enter at least 0.001 SOL.' : 'Enter at least 0.1 USDC.');
      return;
    }
    const depositing = props.custodyMode === 'legacy' && mode === 'deposit';
    const target = depositing ? props.treasuryPubkey : destination.trim();
    if (target.length === 0) {
      setError('Enter a destination address.');
      return;
    }
    setPending(true);
    setError('');
    setNotice('');
    setSignature('');
    try {
      const result = await sendWalletTransfer({
        rpcUrl: props.rpcUrl,
        source: props.address,
        destination: target,
        asset,
        network: props.network,
        amountAtomic,
        signTransaction: props.signTransaction,
      });
      setSignature(result);
      setNotice(depositing
        ? 'Deposit sent on-chain. Waiting for Called It to credit it...'
        : `${asset.toUpperCase()} sent successfully.`);
      await refreshBalance();
      if (depositing) {
        void watchForDepositCredit(asset, account?.balances[asset].availableAtomic ?? null);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Transfer failed.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-4">
      {error.length > 0 && <WalletStatus tone="error">{error}</WalletStatus>}
      {accountError.length > 0 && <WalletStatus tone="error">{accountError}</WalletStatus>}
      {notice.length > 0 && <WalletStatus tone="success">{notice}</WalletStatus>}
      {props.custodyMode === 'legacy' && <Card className="rounded-lg">
        <div className="flex items-start justify-between gap-3">
          <WalletHeading icon={<ShieldCheck />} title="Called It balance" subtitle="Funds available for calls and withdrawals" />
          <button type="button" title="Refresh Called It balance" className="grid size-11 shrink-0 place-items-center rounded-lg border border-line text-fog hover:bg-night-800" onClick={() => void refreshAccount().catch(() => undefined)}>
            <RefreshCw size={18} />
          </button>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-5 border-y border-line py-4">
          <BalanceValue label="SOL available" value={account?.balances.sol.availableAtomic ?? null} asset="sol" />
          <BalanceValue label="SOL locked" value={account?.balances.sol.lockedAtomic ?? null} asset="sol" />
          <BalanceValue label="USDC available" value={account?.balances.usdc.availableAtomic ?? null} asset="usdc" />
          <BalanceValue label="USDC locked" value={account?.balances.usdc.lockedAtomic ?? null} asset="usdc" />
        </div>
        <p className="mt-4 text-sm leading-6 text-fog">Available funds can be used or withdrawn. Locked funds return or pay out in the same asset when each call settles.</p>
      </Card>}
      <Card className="rounded-lg">
        <div className="flex items-start justify-between gap-3">
          <WalletHeading icon={<WalletCards />} title="Your wallet" subtitle={props.network === 'devnet' ? 'Solana devnet' : 'Solana mainnet'} />
          <button type="button" title="Refresh balance" className="grid size-11 shrink-0 place-items-center rounded-lg border border-line text-fog hover:bg-night-800" onClick={() => void refreshBalance()}>
            <RefreshCw size={18} />
          </button>
        </div>
        <div className="my-5 grid grid-cols-1 gap-4 border-y border-line py-4 sm:grid-cols-2">
          <BalanceValue label="On-chain SOL" value={balances?.sol ?? null} asset="sol" />
          <BalanceValue label="On-chain USDC" value={balances?.usdc ?? null} asset="usdc" />
        </div>
        <WalletValue label="Receive SOL or USDC at" value={props.address} copied={copied} onCopy={() => void copyAddress()} />
        {props.custodyMode === 'escrow' && (
          <p className="mt-4 text-sm leading-6 text-fog">
            Send SOL or canonical USDC to this address. Called It cannot withdraw it; only approvals you sign can fund a position.
          </p>
        )}
      </Card>

      {props.custodyMode === 'escrow' && (
        <Card className="rounded-lg">
          <div className="flex items-start justify-between gap-3">
            <WalletHeading icon={<ShieldCheck />} title="Escrow positions" subtitle="Read from finalized Solana indexer state" />
            <button type="button" title="Refresh escrow positions" className="grid size-11 shrink-0 place-items-center rounded-lg border border-line text-fog hover:bg-night-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pitch-300" onClick={() => void refreshEscrowPositions().catch(() => undefined)}>
              <RefreshCw size={18} />
            </button>
          </div>
          <div className="mt-5 divide-y divide-line border-y border-line">
            {escrowPositions === null ? (
              <p className="py-5 text-sm text-fog">Loading positions...</p>
            ) : escrowPositions.length === 0 ? (
              <p className="py-5 text-sm leading-6 text-fog">No escrow positions yet. Approve one from a call in Telegram.</p>
            ) : escrowPositions.map((position) => (
              <EscrowPositionRow key={`${position.marketId}:${position.side}`} position={position} />
            ))}
          </div>
        </Card>
      )}

      <Card className="rounded-lg">
        <div className="mb-4 grid grid-cols-2 gap-1 rounded-lg bg-night-800 p-1" aria-label="Asset">
          <AssetButton asset="sol" active={asset === 'sol'} onClick={() => { setAsset('sol'); setAmount('0.01'); }} />
          <AssetButton asset="usdc" active={asset === 'usdc'} onClick={() => { setAsset('usdc'); setAmount('1'); }} />
        </div>
        {props.custodyMode === 'legacy' && <div className="grid grid-cols-2 gap-1 rounded-lg bg-night-800 p-1">
          <ModeButton active={mode === 'deposit'} onClick={() => setMode('deposit')}>Deposit to Called It</ModeButton>
          <ModeButton active={mode === 'send'} onClick={() => setMode('send')}>Send {asset.toUpperCase()}</ModeButton>
        </div>}
        <form className="mt-5 space-y-4" onSubmit={submitTransfer}>
          {(props.custodyMode === 'escrow' || mode === 'send') && <label className="block space-y-2 text-sm font-semibold text-chalk"><span>Destination address</span><input required value={destination} onChange={(event) => setDestination(event.target.value)} className={walletInputClass} /></label>}
          <label className="block space-y-2 text-sm font-semibold text-chalk"><span>Amount in {asset.toUpperCase()}</span><input required inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} className={walletInputClass} /></label>
          <div className="grid grid-cols-3 gap-2">
            {(asset === 'sol' ? ['0.01', '0.05', '0.1'] : ['1', '5', '10']).map((preset) => <button key={preset} type="button" className="min-h-11 rounded-lg border border-line text-sm font-semibold text-fog hover:border-pitch-500 hover:text-chalk" onClick={() => setAmount(preset)}>{preset}</button>)}
          </div>
          {asset === 'usdc' && (
            <p className="text-sm leading-6 text-fog">
              Keep a small SOL balance in this wallet for Solana network fees.
            </p>
          )}
          <WalletButton type="submit" disabled={pending} icon={pending ? <LoaderCircle className="animate-spin" size={18} /> : <Send size={18} />}>
            {props.custodyMode === 'legacy' && mode === 'deposit' ? `Deposit ${asset.toUpperCase()}` : `Send ${asset.toUpperCase()}`}
          </WalletButton>
        </form>
        {signature.length > 0 && <a className="mt-4 block break-all text-sm text-sky-400 underline underline-offset-4" href={explorerTransactionUrl(signature, props.network)} target="_blank" rel="noreferrer">View transaction</a>}
      </Card>

      <Card className="rounded-lg">
        <WalletHeading icon={<ShieldCheck />} title="Security and recovery" subtitle="Privy protects the key. Called It cannot access it." />
        <div className="mt-5 space-y-3">
          {!hasEmail && <SecondaryButton icon={<KeyRound size={18} />} onClick={linkEmail}>Add recovery email</SecondaryButton>}
          {!hasPasskey && <SecondaryButton icon={<KeyRound size={18} />} onClick={() => linkPasskey()}>Add passkey</SecondaryButton>}
          <SecondaryButton icon={<Download size={18} />} onClick={() => void exportWallet({ address: props.address })}>Export wallet</SecondaryButton>
        </div>
      </Card>
    </div>
  );
}

function BalanceValue(props: {
  readonly label: string;
  readonly value: bigint | null;
  readonly asset: WalletAsset;
}) {
  return (
    <div className="min-w-0 px-3 first:pl-0 last:pr-0">
      <p className="text-xs font-semibold uppercase text-fog">{props.label}</p>
      <p className="mt-1 break-words text-xl font-bold text-chalk">
        {props.value === null ? '-' : `${formatWalletAmount(props.value, props.asset)} ${props.asset.toUpperCase()}`}
      </p>
    </div>
  );
}

function EscrowPositionRow(props: { readonly position: EscrowAccountPosition }) {
  const position = props.position;
  const amount = BigInt(position.depositedAtomic);
  const status = position.claimState === 'ready'
    ? 'Ready to claim'
    : position.claimState === 'checking'
      ? 'Claim check pending'
      : position.claimState === 'claimed'
        ? 'Claimed'
        : position.claimState === 'pending'
          ? 'Waiting for activation'
          : 'Open';
  return (
    <div className="py-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="break-words text-sm font-bold text-chalk">
            {position.side === 'back' ? 'It happens' : 'It does not'} · {formatWalletAmount(amount, position.asset)} {position.asset.toUpperCase()}
          </p>
          <p className="mt-1 break-all font-mono text-xs text-fog">Call {position.marketId}</p>
        </div>
        <span className="text-sm font-semibold text-pitch-300">{status}</span>
      </div>
      <p className="mt-2 text-xs leading-5 text-fog">
        On-chain state: {position.chainState.replaceAll('_', ' ')}
      </p>
      {(position.claimState === 'ready' || position.claimState === 'checking') && (
        <button
          type="button"
          disabled
          className="mt-3 min-h-11 w-full rounded-lg border border-line px-4 text-sm font-semibold text-fog opacity-70"
        >
          {position.claimState === 'ready' ? 'Claim action is being enabled' : 'Checking claim availability'}
        </button>
      )}
    </div>
  );
}

function AssetButton(props: {
  readonly asset: WalletAsset;
  readonly active: boolean;
  readonly onClick: () => void;
}) {
  return <button type="button" className={`min-h-11 rounded-md px-2 text-sm font-semibold ${props.active ? 'bg-night-700 text-chalk' : 'text-fog'}`} onClick={props.onClick}>{props.asset.toUpperCase()}</button>;
}

function ModeButton(props: { readonly active: boolean; readonly onClick: () => void; readonly children: ReactNode }) {
  return <button type="button" className={`min-h-11 rounded-md px-2 text-sm font-semibold ${props.active ? 'bg-night-700 text-chalk' : 'text-fog'}`} onClick={props.onClick}>{props.children}</button>;
}

function SecondaryButton(props: { readonly icon: ReactNode; readonly onClick: () => void; readonly children: string }) {
  return <button type="button" className="flex min-h-12 w-full items-center justify-center gap-2 rounded-lg border border-line px-4 text-sm font-semibold text-chalk hover:bg-night-800" onClick={props.onClick}>{props.icon}{props.children}</button>;
}
