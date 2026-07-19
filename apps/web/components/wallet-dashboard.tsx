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
  DirectClaimError,
  prepareDirectClaim,
  submitDirectClaim,
} from '@/lib/direct-claim';
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
  readonly escrowProgramId?: string;
  readonly canonicalUsdcMint?: string;
  readonly escrowGenesisHash?: string;
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
    ? 'Wallet ready. Your SOL stays here until you approve a pick.'
    : 'Wallet verified. Add SOL or USDC, then deposit it into Rumble.');
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
      setAccountError('Rumble balance could not refresh. Try again shortly.');
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
      setAccountError('Your picks could not refresh. Your wallet balance is unchanged. Try again.');
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
          setNotice('Deposit credited. Your Rumble balance is ready to use.');
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
        ? 'Deposit sent on-chain. Waiting for Rumble to credit it...'
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
      {props.custodyMode === 'legacy' && <Card>
        <div className="flex items-start justify-between gap-3">
          <WalletHeading icon={<ShieldCheck />} title="Rumble balance" subtitle="Funds available for calls and withdrawals" />
          <button type="button" title="Refresh Rumble balance" className="grid size-11 shrink-0 place-items-center border border-line text-fog hover:border-pitch-500 hover:bg-night-800" onClick={() => void refreshAccount().catch(() => undefined)}>
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
      <Card>
        <div className="flex items-start justify-between gap-3">
          <WalletHeading icon={<WalletCards />} title="Your wallet" subtitle={props.network === 'devnet' ? 'Solana devnet' : 'Solana mainnet'} />
          <button type="button" title="Refresh balance" className="grid size-11 shrink-0 place-items-center border border-line text-fog hover:border-pitch-500 hover:bg-night-800" onClick={() => void refreshBalance()}>
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
            Send SOL or USDC to this address. Rumble can only use what you approve for a pick.
          </p>
        )}
      </Card>

      {props.custodyMode === 'escrow' && (
        <Card>
          <div className="flex items-start justify-between gap-3">
            <WalletHeading icon={<ShieldCheck />} title="Your picks" subtitle="Confirmed on Solana" />
            <button type="button" title="Refresh picks" className="grid size-11 shrink-0 place-items-center border border-line text-fog hover:border-pitch-500 hover:bg-night-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pitch-300" onClick={() => void refreshEscrowPositions().catch(() => undefined)}>
              <RefreshCw size={18} />
            </button>
          </div>
          <div className="mt-5 divide-y divide-line border-y border-line">
            {escrowPositions === null ? (
              <p className="py-5 text-sm text-fog">Loading your picks...</p>
            ) : escrowPositions.length === 0 ? (
              <p className="py-5 text-sm leading-6 text-fog">No picks yet. Make one from a call in Telegram.</p>
            ) : escrowPositions.map((position) => (
              <EscrowPositionRow
                key={`${position.marketId}:${position.side}`}
                position={position}
                network={props.network}
                rpcUrl={props.rpcUrl}
                owner={props.address}
                programId={props.escrowProgramId}
                canonicalUsdcMint={props.canonicalUsdcMint}
                expectedGenesisHash={props.escrowGenesisHash}
                signTransaction={props.signTransaction}
                onFinalized={async () => {
                  await Promise.all([refreshEscrowPositions(), refreshBalance()]);
                }}
              />
            ))}
          </div>
        </Card>
      )}

      <Card>
        <div className="mb-4 grid grid-cols-2 gap-1 bg-night-800 p-1" aria-label="Asset">
          <AssetButton asset="sol" active={asset === 'sol'} onClick={() => { setAsset('sol'); setAmount('0.01'); }} />
          <AssetButton asset="usdc" active={asset === 'usdc'} onClick={() => { setAsset('usdc'); setAmount('1'); }} />
        </div>
        {props.custodyMode === 'legacy' && <div className="grid grid-cols-2 gap-1 bg-night-800 p-1">
          <ModeButton active={mode === 'deposit'} onClick={() => setMode('deposit')}>Deposit to Rumble</ModeButton>
          <ModeButton active={mode === 'send'} onClick={() => setMode('send')}>Send {asset.toUpperCase()}</ModeButton>
        </div>}
        <form className="mt-5 space-y-4" onSubmit={submitTransfer}>
          {(props.custodyMode === 'escrow' || mode === 'send') && <label className="block space-y-2 text-sm font-semibold text-chalk"><span>Destination address</span><input required value={destination} onChange={(event) => setDestination(event.target.value)} className={walletInputClass} /></label>}
          <label className="block space-y-2 text-sm font-semibold text-chalk"><span>Amount in {asset.toUpperCase()}</span><input required inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} className={walletInputClass} /></label>
          <div className="grid grid-cols-3 gap-2">
            {(asset === 'sol' ? ['0.01', '0.05', '0.1'] : ['1', '5', '10']).map((preset) => <button key={preset} type="button" className="min-h-11 border border-line font-mono text-sm font-medium text-fog hover:border-pitch-500 hover:text-chalk" onClick={() => setAmount(preset)}>{preset}</button>)}
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
        {signature.length > 0 && <a className="mt-4 block break-all text-sm text-pitch-300 underline underline-offset-4" href={explorerTransactionUrl(signature, props.network)} target="_blank" rel="noreferrer">View on Solana</a>}
      </Card>

      <Card>
        <WalletHeading icon={<ShieldCheck />} title="Security and recovery" subtitle="Privy protects the key. Rumble cannot access it." />
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

type DirectClaimPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending'; readonly label: string }
  | { readonly kind: 'failed'; readonly text: string }
  | { readonly kind: 'unknown'; readonly signature: string | null }
  | { readonly kind: 'finalized'; readonly signature: string | null };

type ClaimEligibility = 'checking' | 'ready' | 'hidden' | 'unavailable' | 'claimed';

function EscrowPositionRow(props: {
  readonly position: EscrowAccountPosition;
  readonly network: 'devnet' | 'mainnet-beta';
  readonly rpcUrl: string;
  readonly owner: string;
  readonly programId?: string;
  readonly canonicalUsdcMint?: string;
  readonly expectedGenesisHash?: string;
  readonly signTransaction: (transaction: Uint8Array) => Promise<Uint8Array>;
  readonly onFinalized: () => Promise<void>;
}) {
  const position = props.position;
  const [claim, setClaim] = useState<DirectClaimPhase>({ kind: 'idle' });
  const [eligibility, setEligibility] = useState<ClaimEligibility>(
    position.claimState === 'claimed' ? 'claimed' : 'checking',
  );
  const amount = BigInt(position.depositedAtomic);
  const status = eligibility === 'ready'
    ? 'Ready to claim'
    : eligibility === 'checking'
      ? 'Claim check pending'
      : eligibility === 'claimed' || position.claimState === 'claimed'
        ? 'Claimed'
        : position.claimState === 'pending'
          ? 'Waiting for activation'
          : 'Open';

  useEffect(() => {
    if (position.claimState === 'claimed') {
      setEligibility('claimed');
      return;
    }
    if (
      props.programId === undefined ||
      props.canonicalUsdcMint === undefined ||
      props.expectedGenesisHash === undefined
    ) {
      setEligibility('unavailable');
      return;
    }
    let cancelled = false;
    setEligibility('checking');
    void prepareDirectClaim({
      canonicalUsdcMint: props.canonicalUsdcMint,
      expectedGenesisHash: props.expectedGenesisHash,
      marketId: position.marketId,
      network: props.network,
      owner: props.owner,
      programId: props.programId,
      rpcUrl: props.rpcUrl,
    }).then(() => {
      if (!cancelled) setEligibility('ready');
    }).catch((cause) => {
      if (cancelled) return;
      if (cause instanceof DirectClaimError && cause.code === 'already_claimed') {
        setEligibility('claimed');
      } else if (cause instanceof DirectClaimError && cause.code === 'claim_not_ready') {
        setEligibility('hidden');
      } else {
        setEligibility('unavailable');
      }
    });
    return () => { cancelled = true; };
  }, [
    position.claimState,
    position.marketId,
    props.canonicalUsdcMint,
    props.expectedGenesisHash,
    props.network,
    props.owner,
    props.programId,
    props.rpcUrl,
  ]);
  return (
    <div className="py-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="break-words text-sm font-bold text-chalk">
            {position.side === 'back' ? 'Yes' : 'No'} · {formatWalletAmount(amount, position.asset)} {position.asset.toUpperCase()}
          </p>
          <p className="mt-1 break-all font-mono text-xs text-fog">Call {position.marketId}</p>
        </div>
        <span className="text-sm font-semibold text-pitch-300">{status}</span>
      </div>
      <p className="mt-2 text-xs leading-5 text-fog">
        Status: {position.chainState.replaceAll('_', ' ')}
      </p>
      {position.replay && (
        <p className="mt-2 text-xs font-semibold text-pitch-300">
          Completed-match replay · Uses {props.network === 'devnet' ? 'devnet test assets' : 'allowlisted mainnet assets'} · No Points
        </p>
      )}
      {claim.kind === 'failed' && <p className="mt-3 text-sm leading-6 text-siren-400">{claim.text}</p>}
      {claim.kind === 'unknown' && (
        <p className="mt-3 text-sm leading-6 text-flood-300">
          Confirmation is still unknown. Do not sign again yet. Refresh this wallet to check finalized state.
        </p>
      )}
      {claim.kind === 'finalized' && (
        <p className="mt-3 text-sm font-semibold text-pitch-300">Claim finalized. Assets were sent to this wallet.</p>
      )}
      {eligibility === 'unavailable' && position.claimState === 'ready' && claim.kind === 'idle' && (
        <p className="mt-3 text-sm leading-6 text-flood-300">
          Finalized claim state is temporarily unavailable. No assets moved. Refresh and try again.
        </p>
      )}
      {(claim.kind === 'unknown' || claim.kind === 'finalized') && claim.signature !== null && (
        <a
          className="mt-2 inline-flex min-h-11 items-center break-all text-sm text-pitch-300 underline underline-offset-4"
          href={explorerTransactionUrl(claim.signature, props.network)}
          target="_blank"
          rel="noreferrer"
        >
          View claim transaction
        </a>
      )}
      {eligibility === 'ready' && claim.kind !== 'finalized' && (
        <button
          type="button"
          disabled={claim.kind === 'pending' || claim.kind === 'unknown'}
          className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 border border-pitch-500 px-4 font-mono text-sm font-medium text-chalk hover:bg-pitch-500/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pitch-300 disabled:cursor-not-allowed disabled:opacity-60"
          onClick={() => void claimPosition()}
        >
          {claim.kind === 'pending' && <LoaderCircle className="animate-spin motion-reduce:animate-none" size={18} />}
          {claim.kind === 'pending' ? claim.label : position.chainState === 'voided' ? 'Get returned SOL' : 'Get winnings'}
        </button>
      )}
    </div>
  );

  async function claimPosition(): Promise<void> {
    if (
      props.programId === undefined ||
      props.canonicalUsdcMint === undefined ||
      props.expectedGenesisHash === undefined
    ) {
      setClaim({
        kind: 'failed',
        text: 'Direct claim configuration is unavailable. No assets moved. Refresh after configuration is restored.',
      });
      return;
    }
    try {
      setClaim({ kind: 'pending', label: 'Checking finalized state...' });
      const preparation = await prepareDirectClaim({
        canonicalUsdcMint: props.canonicalUsdcMint,
        expectedGenesisHash: props.expectedGenesisHash,
        marketId: position.marketId,
        network: props.network,
        owner: props.owner,
        programId: props.programId,
        rpcUrl: props.rpcUrl,
      });
      setClaim({ kind: 'pending', label: 'Approve in Privy...' });
      const signedBytes = await props.signTransaction(preparation.transaction.serialize());
      setClaim({ kind: 'pending', label: 'Waiting for finality...' });
      const result = await submitDirectClaim({
        preparation,
        rpcUrl: props.rpcUrl,
        signedBytes,
      });
      if (result.kind === 'unknown') {
        setClaim({ kind: 'unknown', signature: result.signature });
        return;
      }
      setEligibility('claimed');
      setClaim({ kind: 'finalized', signature: result.signature });
      await props.onFinalized();
    } catch (cause) {
      if (cause instanceof DirectClaimError && cause.code === 'already_claimed') {
        setEligibility('claimed');
        setClaim({ kind: 'finalized', signature: null });
        await props.onFinalized();
        return;
      }
      setClaim({ kind: 'failed', text: directClaimErrorMessage(cause) });
    }
  }
}

function directClaimErrorMessage(cause: unknown): string {
  if (!(cause instanceof DirectClaimError)) {
    return 'Claim approval was cancelled or interrupted. No new claim was submitted. Try again.';
  }
  switch (cause.code) {
    case 'claim_not_ready':
      return 'This pick is not ready yet. No SOL moved. Refresh after Rumble settles the call.';
    case 'already_claimed':
      return 'This payment was already collected. Refresh your wallet.';
    case 'blockhash_expired':
      return 'The claim approval expired before submission. No assets moved. Try again.';
    case 'network_mismatch':
      return 'This pick is on another Solana network. No SOL moved. Switch to the right network.';
    case 'identity_mismatch':
    case 'transaction_changed':
      return 'The claim destination or transaction did not match this wallet. Nothing was submitted. Refresh the wallet.';
    case 'insufficient_fee_balance':
      return 'This wallet needs a small SOL balance for the claim fee. No assets moved. Add SOL and try again.';
    case 'onchain_failure':
      return 'Solana rejected the claim. No claim was finalized. Refresh finalized state before retrying.';
    case 'rpc_unavailable':
      return 'Finalized Solana state is temporarily unavailable. No claim was submitted. Try again shortly.';
  }
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
  return <button type="button" className="flex min-h-12 w-full items-center justify-center gap-2 border border-line px-4 font-mono text-sm font-medium text-chalk hover:border-pitch-500 hover:bg-night-800" onClick={props.onClick}>{props.icon}{props.children}</button>;
}
