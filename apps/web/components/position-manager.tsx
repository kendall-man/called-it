'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  usePrivy,
  useSubscribeToJwtAuthWithFlag,
  useUser,
  type WalletWithMetadata,
} from '@privy-io/react-auth';
import {
  useSignTransaction,
  useWallets,
  type ConnectedStandardSolanaWallet,
} from '@privy-io/react-auth/solana';
import {
  ArrowLeft,
  CheckCircle2,
  Clock3,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  WalletCards,
} from 'lucide-react';
import { Card } from '@/components/ui';
import {
  PositionChainError,
  transactionToBase64,
  verifyPositionPreparation,
  verifySignedPosition,
  type VerifiedPositionPreparation,
} from '@/lib/position-chain';
import {
  PositionClientError,
  requestPositionAuthSession,
  requestPositionStatus,
  requestPreparedPosition,
  submitSignedPosition,
} from '@/lib/position-client';
import {
  positionFailure,
  positionStatusCopy,
  type PositionFailurePresentation,
} from '@/lib/position-flow';
import { formatWalletAmount } from '@/lib/wallet-transfers';
import { isPrivySolanaWalletAccount } from '@/lib/wallet-flow';
import { WalletButton, WalletState } from './wallet-ui';

export type PositionManagerProps = {
  readonly botUsername: string;
  readonly canonicalUsdcMint: string;
  readonly network: 'devnet' | 'mainnet-beta';
  readonly programId: string;
  readonly rpcUrl: string;
  readonly token: string;
};

type AuthSession = {
  readonly jwt: string;
  readonly expiresAt: string;
};

type FlowState =
  | { readonly kind: 'opening' }
  | { readonly kind: 'ready'; readonly preparation: VerifiedPositionPreparation; readonly title: string; readonly choice: string }
  | { readonly kind: 'signing'; readonly preparation: VerifiedPositionPreparation; readonly title: string; readonly choice: string }
  | { readonly kind: 'confirming'; readonly signature: string | null; readonly positionState: 'pending' | 'active' | 'invalidated' | 'refundable' | 'claimed' | null }
  | { readonly kind: 'finalized'; readonly signature: string; readonly positionState: 'pending' | 'active' | 'invalidated' | 'refundable' | 'claimed' | null }
  | { readonly kind: 'failed'; readonly failure: PositionFailurePresentation };

const AUTH_TIMEOUT_MS = 25_000;
const WALLET_READY_TIMEOUT_MS = 25_000;

export function PositionManager(props: PositionManagerProps) {
  const { ready, authenticated, error: privyError, getAccessToken } = usePrivy();
  const { user } = useUser();
  const { ready: walletsReady, wallets } = useWallets();
  const { signTransaction } = useSignTransaction();
  const [session, setSession] = useState<AuthSession | null>(null);
  const [flow, setFlow] = useState<FlowState>({ kind: 'opening' });
  const jwt = useRef<string | undefined>(undefined);
  const preparationAttempt = useRef('');

  const fail = useCallback((code: string) => {
    setFlow({ kind: 'failed', failure: positionFailure(code) });
  }, []);
  const getExternalJwt = useCallback(async () => jwt.current, []);
  const jwtAuth = useSubscribeToJwtAuthWithFlag({
    enabled: session !== null,
    isAuthenticated: session !== null,
    isLoading: session === null,
    getExternalJwt,
    onError: () => fail('privy_auth_required'),
  });

  const embeddedWalletAddress = user?.linkedAccounts.find((account): account is WalletWithMetadata => (
    isPrivySolanaWalletAccount(account)
  ))?.address ?? null;
  const activeWallet = embeddedWalletAddress === null
    ? null
    : wallets.find((wallet) => wallet.address === embeddedWalletAddress) ?? null;

  useEffect(() => {
    let cancelled = false;
    void requestPositionAuthSession(props.token).then((result) => {
      if (cancelled) return;
      jwt.current = result.jwt;
      setSession({ jwt: result.jwt, expiresAt: result.expiresAt });
    }).catch((cause: unknown) => {
      if (!cancelled) fail(clientErrorCode(cause));
    });
    return () => { cancelled = true; };
  }, [fail, props.token]);

  useEffect(() => {
    if (privyError !== null) fail('sponsor_unavailable');
  }, [fail, privyError]);

  useEffect(() => {
    if (session === null || flow.kind !== 'opening') return;
    if (jwtAuth.state.status === 'not-enabled') {
      const timeout = window.setTimeout(() => fail('sponsor_unavailable'), 1_500);
      return () => window.clearTimeout(timeout);
    }
    if (jwtAuth.state.status === 'error') {
      fail('privy_auth_required');
      return;
    }
    if (jwtAuth.state.status === 'done' && ready && authenticated) return;
    const timeout = window.setTimeout(() => fail('privy_auth_required'), AUTH_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [authenticated, fail, flow.kind, jwtAuth.state.status, ready, session]);

  useEffect(() => {
    if (
      session === null || flow.kind !== 'opening' || jwtAuth.state.status !== 'done' ||
      !ready || !authenticated || !walletsReady || activeWallet !== null
    ) return;
    const timeout = window.setTimeout(() => fail('sponsor_unavailable'), WALLET_READY_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [activeWallet, authenticated, fail, flow.kind, jwtAuth.state.status, ready, session, walletsReady]);

  const prepare = useCallback(async (wallet: ConnectedStandardSolanaWallet) => {
    const attempt = `${props.token}:${wallet.address}`;
    if (preparationAttempt.current === attempt) return;
    preparationAttempt.current = attempt;
    try {
      const accessToken = await getAccessToken();
      if (accessToken === null) throw new PositionClientError('privy_auth_required');
      const current = await requestPositionStatus({
        token: props.token,
        accessToken,
        pubkey: wallet.address,
      });
      if (current.stage === 'finalized' && current.signature !== null) {
        setFlow({
          kind: 'finalized',
          signature: current.signature,
          positionState: current.positionState,
        });
        return;
      }
      if (current.stage === 'confirming') {
        setFlow({
          kind: 'confirming',
          signature: current.signature,
          positionState: current.positionState,
        });
        return;
      }
      if (current.stage === 'unknown_confirmation') {
        fail('unknown_confirmation');
        return;
      }
      const prepared = await requestPreparedPosition({
        token: props.token,
        accessToken,
        pubkey: wallet.address,
      });
      const verified = await verifyPositionPreparation({
        authorization: prepared.authorization,
        canonicalUsdcMint: props.canonicalUsdcMint,
        expectedProgramId: props.programId,
        network: props.network,
        ownerPubkey: wallet.address,
        rawTransactionBase64: prepared.rawTransactionBase64,
        rpcUrl: props.rpcUrl,
      });
      setFlow({
        kind: 'ready',
        preparation: verified,
        title: prepared.terms.title,
        choice: prepared.terms.choice,
      });
    } catch (cause) {
      fail(clientErrorCode(cause));
    }
  }, [
    fail,
    getAccessToken,
    props.canonicalUsdcMint,
    props.network,
    props.programId,
    props.rpcUrl,
    props.token,
  ]);

  useEffect(() => {
    if (
      flow.kind !== 'opening' || session === null || jwtAuth.state.status !== 'done' ||
      !ready || !authenticated || !walletsReady || activeWallet === null
    ) return;
    void prepare(activeWallet);
  }, [activeWallet, authenticated, flow.kind, jwtAuth.state.status, prepare, ready, session, walletsReady]);

  useEffect(() => {
    if (flow.kind !== 'confirming' || activeWallet === null) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const accessToken = await getAccessToken();
        if (accessToken === null) throw new PositionClientError('privy_auth_required');
        const status = await requestPositionStatus({
          token: props.token,
          accessToken,
          pubkey: activeWallet.address,
        });
        if (cancelled) return;
        if (status.stage === 'finalized' && status.signature !== null) {
          setFlow({
            kind: 'finalized',
            signature: status.signature,
            positionState: status.positionState,
          });
        } else if (status.stage === 'unknown_confirmation') {
          fail('unknown_confirmation');
        } else {
          setFlow({
            kind: 'confirming',
            signature: status.signature,
            positionState: status.positionState,
          });
        }
      } catch (cause) {
        if (!cancelled && clientErrorCode(cause) !== 'rpc_unavailable') {
          fail(clientErrorCode(cause));
        }
      }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), 3_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeWallet, fail, flow.kind, getAccessToken, props.token]);

  const approve = useCallback(async () => {
    if (flow.kind !== 'ready' || activeWallet === null) return;
    const { preparation, title, choice } = flow;
    if (BigInt(Math.floor(Date.now() / 1_000)) >= BigInt(preparation.authorization.expiresAt)) {
      fail('session_expired');
      return;
    }
    setFlow({ kind: 'signing', preparation, title, choice });
    try {
      const chain = props.network === 'devnet' ? 'solana:devnet' : 'solana:mainnet';
      const signedBytes = (await signTransaction({
        transaction: preparation.transaction.serialize(),
        wallet: activeWallet,
        chain,
        options: { uiOptions: { showWalletUIs: true } },
      })).signedTransaction;
      const signed = await verifySignedPosition(
        preparation,
        activeWallet.address,
        signedBytes,
        props.rpcUrl,
      );
      const accessToken = await getAccessToken();
      if (accessToken === null) throw new PositionClientError('privy_auth_required');
      const accepted = await submitSignedPosition({
        token: props.token,
        accessToken,
        pubkey: activeWallet.address,
        rawTransactionBase64: transactionToBase64(signed),
      });
      setFlow({ kind: 'confirming', signature: accepted.signature, positionState: null });
    } catch (cause) {
      const code = clientErrorCode(cause);
      if (code === 'unknown_confirmation') {
        try {
          const accessToken = await getAccessToken();
          if (accessToken !== null) {
            const status = await requestPositionStatus({
              token: props.token,
              accessToken,
              pubkey: activeWallet.address,
            });
            if (status.stage === 'confirming' || status.stage === 'finalized') {
              setFlow(status.stage === 'finalized' && status.signature !== null
                ? { kind: 'finalized', signature: status.signature, positionState: status.positionState }
                : { kind: 'confirming', signature: status.signature, positionState: status.positionState });
              return;
            }
          }
        } catch {
          // The unknown-confirmation copy tells the user not to sign again.
        }
      }
      fail(code);
    }
  }, [activeWallet, fail, flow, getAccessToken, props.network, props.rpcUrl, props.token, signTransaction]);

  const returnToTelegram = useCallback(() => {
    if (props.botUsername.length === 0) {
      window.history.back();
      return;
    }
    window.location.assign(`https://t.me/${encodeURIComponent(props.botUsername)}`);
  }, [props.botUsername]);

  if (flow.kind === 'failed') {
    const action = flow.failure.action === 'return' || flow.failure.action === 'fund'
      ? returnToTelegram
      : () => window.location.reload();
    return (
      <WalletState
        title={flow.failure.title}
        text={flow.failure.text}
        action={(
          <div className="mt-5">
            <WalletButton
              icon={flow.failure.action === 'return' || flow.failure.action === 'fund'
                ? <ArrowLeft size={18} />
                : <RefreshCw size={18} />}
              onClick={action}
            >
              {flow.failure.actionLabel}
            </WalletButton>
          </div>
        )}
      />
    );
  }
  if (flow.kind === 'confirming') {
    const copy = positionStatusCopy('confirming', flow.positionState);
    return <WalletState title={copy.title} text={copy.text} loading />;
  }
  if (flow.kind === 'finalized') {
    const copy = positionStatusCopy('finalized', flow.positionState);
    return (
      <WalletState
        title={copy.title}
        text={copy.text}
        action={(
          <div className="mt-5">
            <WalletButton icon={<ArrowLeft size={18} />} onClick={returnToTelegram}>
              Return to Telegram
            </WalletButton>
          </div>
        )}
      />
    );
  }
  if (flow.kind === 'opening' || activeWallet === null) {
    const text = session === null
      ? 'Checking this private approval link...'
      : jwtAuth.state.status !== 'done'
        ? 'Confirming your Telegram and Privy wallet...'
        : 'Checking the exact position on Solana...';
    return <WalletState title="Opening position" text={text} loading />;
  }

  const preparation = flow.preparation;
  const asset = preparation.authorization.asset;
  const amount = BigInt(preparation.authorization.amount);
  const signing = flow.kind === 'signing';
  return (
    <div className="space-y-4">
      <header className="space-y-2">
        <p className="text-xs font-semibold uppercase text-pitch-300">Secure on-chain approval</p>
        <h1 className="display-type text-4xl text-chalk sm:text-5xl">Review position</h1>
        <p className="max-w-lg text-sm leading-6 text-fog">
          Your Privy wallet signs only the exact details shown below.
        </p>
      </header>
      <Card className="rounded-lg" aria-live="polite">
        <div className="flex items-start justify-between gap-3 border-b border-line pb-4">
          <div className="min-w-0">
            <p className="break-words text-lg font-bold leading-7 text-chalk">{flow.title}</p>
            <p className="mt-1 text-sm font-semibold text-pitch-300">{flow.choice}</p>
          </div>
          <span className="shrink-0 rounded-full border border-line bg-night-800 px-2.5 py-1 text-xs font-semibold uppercase text-fog">
            {asset}
          </span>
        </div>

        <dl className="grid grid-cols-1 gap-x-5 gap-y-4 py-5 sm:grid-cols-2">
          <Metric icon={<WalletCards size={17} />} label="Amount" value={`${formatWalletAmount(amount, asset)} ${asset.toUpperCase()}`} />
          <Metric icon={<ShieldCheck size={17} />} label="Network" value={props.network === 'devnet' ? 'Devnet · test assets' : 'Mainnet · real assets'} />
          <Metric icon={<WalletCards size={17} />} label="Wallet balance" value={`${formatWalletAmount(preparation.balances[asset], asset)} ${asset.toUpperCase()}`} />
          <Metric icon={<LockKeyhole size={17} />} label="Locked multiplier" value={preparation.lockedMultiplier} />
          <Metric icon={<CheckCircle2 size={17} />} label="Currently matched" value={`${preparation.currentMatchedPercent.toFixed(2)}%`} />
          <Metric icon={<Clock3 size={17} />} label="Max possible return" value={`${formatWalletAmount(preparation.maxPossibleReturnAtomic, asset)} ${asset.toUpperCase()}`} />
        </dl>

        <div className="border-t border-line pt-4">
          <p className="text-sm leading-6 text-fog">
            Funds move from your Privy wallet into this call&apos;s on-chain vault only after you approve. The sponsor pays the Solana network fee.
          </p>
          <div className="mt-4">
            <WalletButton
              disabled={signing}
              icon={signing ? <LoaderCircle className="animate-spin" size={18} /> : <LockKeyhole size={18} />}
              onClick={() => void approve()}
            >
              {signing ? 'Waiting for wallet approval' : `Approve ${formatWalletAmount(amount, asset)} ${asset.toUpperCase()}`}
            </WalletButton>
          </div>
          <p className="mt-3 text-center text-xs leading-5 text-fog">
            Approval expires {new Date(preparation.authorization.expiresAt ? Number(preparation.authorization.expiresAt) * 1_000 : 0).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.
          </p>
        </div>
      </Card>
    </div>
  );
}

function Metric(props: { readonly icon: ReactNode; readonly label: string; readonly value: string }) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-2 text-xs font-semibold uppercase text-fog">
        {props.icon}{props.label}
      </dt>
      <dd className="mt-1 break-words text-base font-bold text-chalk">{props.value}</dd>
    </div>
  );
}

function clientErrorCode(cause: unknown): string {
  if (cause instanceof PositionClientError || cause instanceof PositionChainError) return cause.code;
  if (cause instanceof Error && /reject|cancel|denied/i.test(cause.message)) return 'wallet_rejected';
  return 'sponsor_unavailable';
}
