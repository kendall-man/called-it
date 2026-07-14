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
  formatSol,
  MIN_WALLET_TRANSFER_LAMPORTS,
  parseSolAmount,
  sendWalletTransfer,
  walletBalance,
} from '@/lib/wallet-transfers';
import {
  requestWalletAccount,
  type WalletAccountSummary,
} from '@/lib/wallet-client';
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
  readonly signTransaction: (transaction: Uint8Array) => Promise<Uint8Array>;
};

export function WalletDashboard(props: WalletDashboardProps) {
  const { user, getAccessToken, linkEmail, linkPasskey } = usePrivy();
  const { exportWallet } = useExportWallet();
  const [balance, setBalance] = useState<bigint | null>(null);
  const [account, setAccount] = useState<WalletAccountSummary | null>(null);
  const [accountError, setAccountError] = useState('');
  const [amount, setAmount] = useState('0.01');
  const [mode, setMode] = useState<'deposit' | 'send'>('deposit');
  const [destination, setDestination] = useState('');
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState('Wallet verified. Send SOL here, then deposit it into Called It.');
  const [error, setError] = useState('');
  const [signature, setSignature] = useState('');
  const hasEmail = user?.linkedAccounts.some((account) => account.type === 'email') ?? false;
  const hasPasskey = user?.linkedAccounts.some((account) => account.type === 'passkey') ?? false;

  const refreshBalance = useCallback(async () => {
    try {
      setBalance(await walletBalance(props.rpcUrl, new PublicKey(props.address)));
    } catch {
      setNotice('Balance could not refresh. Try again shortly.');
    }
  }, [props.address, props.rpcUrl]);

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

  useEffect(() => {
    void refreshBalance();
    void refreshAccount().catch(() => undefined);
    const interval = window.setInterval(() => {
      void refreshAccount().catch(() => undefined);
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [refreshAccount, refreshBalance]);

  const watchForDepositCredit = useCallback(async (previousAvailable: bigint | null) => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 5_000));
      try {
        const summary = await refreshAccount();
        if (previousAvailable === null || summary.availableLamports > previousAvailable) {
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
    const lamports = parseSolAmount(amount);
    if (lamports === null || lamports < MIN_WALLET_TRANSFER_LAMPORTS) {
      setError('Enter at least 0.001 SOL.');
      return;
    }
    const target = mode === 'deposit' ? props.treasuryPubkey : destination.trim();
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
        lamports,
        signTransaction: props.signTransaction,
      });
      setSignature(result);
      setNotice(mode === 'deposit'
        ? 'Deposit sent on-chain. Waiting for Called It to credit it...'
        : 'SOL sent successfully.');
      await refreshBalance();
      if (mode === 'deposit') {
        void watchForDepositCredit(account?.availableLamports ?? null);
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
      <Card className="rounded-lg">
        <div className="flex items-start justify-between gap-3">
          <WalletHeading icon={<ShieldCheck />} title="Called It balance" subtitle="Funds available for calls and withdrawals" />
          <button type="button" title="Refresh Called It balance" className="grid size-11 shrink-0 place-items-center rounded-lg border border-line text-fog hover:bg-night-800" onClick={() => void refreshAccount().catch(() => undefined)}>
            <RefreshCw size={18} />
          </button>
        </div>
        <div className="mt-5 grid grid-cols-2 divide-x divide-line border-y border-line py-4">
          <BalanceValue label="Available to use" value={account?.availableLamports ?? null} />
          <BalanceValue label="Locked in open calls" value={account?.lockedLamports ?? null} />
        </div>
        <p className="mt-4 text-sm leading-6 text-fog">Available SOL can be used or withdrawn. Locked SOL returns or pays out when each call settles.</p>
      </Card>
      <Card className="rounded-lg">
        <div className="flex items-start justify-between gap-3">
          <WalletHeading icon={<WalletCards />} title="Your wallet" subtitle={props.network === 'devnet' ? 'Solana devnet' : 'Solana mainnet'} />
          <button type="button" title="Refresh balance" className="grid size-11 shrink-0 place-items-center rounded-lg border border-line text-fog hover:bg-night-800" onClick={() => void refreshBalance()}>
            <RefreshCw size={18} />
          </button>
        </div>
        <div className="my-5 border-y border-line py-4">
          <p className="text-xs font-semibold uppercase text-fog">On-chain balance</p>
          <p className="mt-1 text-3xl font-bold text-chalk">{balance === null ? '-' : `${formatSol(balance)} SOL`}</p>
        </div>
        <WalletValue label="Receive SOL at" value={props.address} copied={copied} onCopy={() => void copyAddress()} />
      </Card>

      <Card className="rounded-lg">
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-night-800 p-1">
          <ModeButton active={mode === 'deposit'} onClick={() => setMode('deposit')}>Deposit to Called It</ModeButton>
          <ModeButton active={mode === 'send'} onClick={() => setMode('send')}>Send SOL</ModeButton>
        </div>
        <form className="mt-5 space-y-4" onSubmit={submitTransfer}>
          {mode === 'send' && <label className="block space-y-2 text-sm font-semibold text-chalk"><span>Destination address</span><input required value={destination} onChange={(event) => setDestination(event.target.value)} className={walletInputClass} /></label>}
          <label className="block space-y-2 text-sm font-semibold text-chalk"><span>Amount in SOL</span><input required inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} className={walletInputClass} /></label>
          <div className="grid grid-cols-3 gap-2">
            {['0.01', '0.05', '0.1'].map((preset) => <button key={preset} type="button" className="min-h-11 rounded-lg border border-line text-sm font-semibold text-fog hover:border-pitch-500 hover:text-chalk" onClick={() => setAmount(preset)}>{preset}</button>)}
          </div>
          <WalletButton type="submit" disabled={pending} icon={pending ? <LoaderCircle className="animate-spin" size={18} /> : <Send size={18} />}>
            {mode === 'deposit' ? 'Deposit SOL' : 'Send SOL'}
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

function BalanceValue(props: { readonly label: string; readonly value: bigint | null }) {
  return (
    <div className="min-w-0 px-3 first:pl-0 last:pr-0">
      <p className="text-xs font-semibold uppercase text-fog">{props.label}</p>
      <p className="mt-1 break-words text-xl font-bold text-chalk">
        {props.value === null ? '-' : `${formatSol(props.value)} SOL`}
      </p>
    </div>
  );
}

function ModeButton(props: { readonly active: boolean; readonly onClick: () => void; readonly children: string }) {
  return <button type="button" className={`min-h-11 rounded-md px-2 text-sm font-semibold ${props.active ? 'bg-night-700 text-chalk' : 'text-fog'}`} onClick={props.onClick}>{props.children}</button>;
}

function SecondaryButton(props: { readonly icon: ReactNode; readonly onClick: () => void; readonly children: string }) {
  return <button type="button" className="flex min-h-12 w-full items-center justify-center gap-2 rounded-lg border border-line px-4 text-sm font-semibold text-chalk hover:bg-night-800" onClick={props.onClick}>{props.icon}{props.children}</button>;
}
