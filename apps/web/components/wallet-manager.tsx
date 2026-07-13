'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  usePrivy,
  useLoginWithTelegram,
  type WalletWithMetadata,
} from '@privy-io/react-auth';
import {
  useCreateWallet,
  useSignMessage,
  useSignTransaction,
  useWallets,
  type ConnectedStandardSolanaWallet,
} from '@privy-io/react-auth/solana';
import { RefreshCw } from 'lucide-react';
import {
  linkPrivyWallet,
  WalletClientError,
  walletClientErrorMessage,
} from '@/lib/wallet-client';
import { WalletDashboard } from './wallet-dashboard';
import { WalletButton, WalletState } from './wallet-ui';

type WalletManagerProps = {
  readonly network: 'devnet' | 'mainnet-beta';
  readonly rpcUrl: string;
  readonly treasuryPubkey: string;
};

type SessionState = { readonly kind: 'loading' | 'invalid' } | {
  readonly kind: 'valid';
  readonly token: string;
};

type Phase = 'opening' | 'authenticating' | 'creating' | 'linking' | 'ready' | 'failed';

export function WalletManager(props: WalletManagerProps) {
  const { ready, authenticated, error: privyError, getAccessToken, logout, user } = usePrivy();
  const { login } = useLoginWithTelegram();
  const { ready: walletsReady, wallets } = useWallets();
  const { createWallet } = useCreateWallet();
  const { signMessage } = useSignMessage();
  const { signTransaction } = useSignTransaction();
  const [session, setSession] = useState<SessionState>({ kind: 'loading' });
  const [phase, setPhase] = useState<Phase>('opening');
  const [error, setError] = useState('');
  const [canRetry, setCanRetry] = useState(true);
  const authAttempted = useRef(false);
  const creationAttempted = useRef(false);
  const linkedAttempt = useRef('');
  const embeddedWalletAddress = user?.linkedAccounts.find((account): account is WalletWithMetadata => (
    account.type === 'wallet' &&
    account.chainType === 'solana' &&
    account.connectorType === 'embedded' &&
    account.walletClientType === 'privy'
  ))?.address ?? null;
  const activeWallet = embeddedWalletAddress === null
    ? null
    : wallets.find((wallet) => wallet.address === embeddedWalletAddress) ?? null;

  useEffect(() => {
    const readSession = () => {
      const token = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
      setSession(/^[A-Za-z0-9_-]{43}$/.test(token)
        ? { kind: 'valid', token }
        : { kind: 'invalid' });
    };
    readSession();
    window.addEventListener('hashchange', readSession);
    return () => window.removeEventListener('hashchange', readSession);
  }, []);

  useEffect(() => {
    if (privyError === null) return;
    setError('Secure wallet services could not start. Return to Telegram and try again.');
    setCanRetry(false);
    setPhase('failed');
  }, [privyError]);

  useEffect(() => {
    if (session.kind !== 'valid' || !ready || authenticated || authAttempted.current) return;
    authAttempted.current = true;
    setPhase('authenticating');
    void login().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : 'Telegram sign-in failed.');
      setCanRetry(true);
      setPhase('failed');
    });
  }, [authenticated, login, ready, session]);

  useEffect(() => {
    if (
      session.kind !== 'valid' || !authenticated || !walletsReady ||
      activeWallet !== null || creationAttempted.current
    ) return;
    creationAttempted.current = true;
    setPhase('creating');
    void createWallet().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : 'Wallet creation failed.');
      setCanRetry(true);
      setPhase('failed');
    });
  }, [activeWallet, authenticated, createWallet, session, walletsReady]);

  const verifyWallet = useCallback(async (
    wallet: ConnectedStandardSolanaWallet,
    token: string,
  ) => {
    const attempt = `${token}:${wallet.address}`;
    if (linkedAttempt.current === attempt) return;
    linkedAttempt.current = attempt;
    setPhase('linking');
    setError('');
    try {
      const accessToken = await getAccessToken();
      if (accessToken === null) throw new Error('Privy access token is unavailable.');
      await linkPrivyWallet({
        sessionToken: token,
        accessToken,
        pubkey: wallet.address,
        signMessage: async (message) => (
          await signMessage({
            message,
            wallet,
            options: { uiOptions: { showWalletUIs: false } },
          })
        ).signature,
      });
      window.history.replaceState(null, '', '/wallet');
      setPhase('ready');
    } catch (cause) {
      setError(walletClientErrorMessage(cause));
      setCanRetry(cause instanceof WalletClientError && cause.code === 'privy_auth_required');
      setPhase('failed');
    }
  }, [getAccessToken, signMessage]);

  useEffect(() => {
    if (session.kind !== 'valid' || !authenticated || activeWallet === null) return;
    void verifyWallet(activeWallet, session.token);
  }, [activeWallet, authenticated, session, verifyWallet]);

  async function retryTelegramAccount() {
    if (session.kind !== 'valid') return;
    setPhase('authenticating');
    setError('');
    linkedAttempt.current = '';
    creationAttempted.current = false;
    authAttempted.current = true;
    try {
      await logout();
      await login();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Telegram sign-in failed.');
      setCanRetry(true);
      setPhase('failed');
    }
  }

  if (session.kind === 'loading') {
    return <WalletState title="Opening wallet" text="Checking this private Telegram session..." loading />;
  }
  if (session.kind === 'invalid') {
    return <WalletState title="Open this from Telegram" text="Send /wallet to Called It in a private chat, then tap Create or manage wallet." />;
  }
  if (phase === 'failed') {
    return (
      <WalletState
        title="Wallet needs attention"
        text={error}
        action={canRetry ? <div className="mt-5"><WalletButton icon={<RefreshCw size={18} />} onClick={() => void retryTelegramAccount()}>Continue with Telegram</WalletButton></div> : undefined}
      />
    );
  }
  if (phase !== 'ready') {
    const state = phaseCopy(phase);
    return <WalletState title={state.title} text={state.text} loading />;
  }
  if (activeWallet === null) {
    return <WalletState title="Opening wallet" text="Loading your Privy wallet..." loading />;
  }

  const chain = props.network === 'devnet' ? 'solana:devnet' : 'solana:mainnet';
  return (
    <>
      <header className="mb-4 space-y-2">
        <p className="text-xs font-semibold uppercase text-pitch-300">Privy-protected Solana wallet</p>
        <h1 className="display-type text-4xl text-chalk sm:text-5xl">Called It Wallet</h1>
        <p className="max-w-lg text-sm leading-6 text-fog">Your key is protected by Privy. Called It cannot see or use it.</p>
      </header>
      <WalletDashboard
        {...props}
        address={activeWallet.address}
        signTransaction={async (transaction) => (
          await signTransaction({ transaction, wallet: activeWallet, chain })
        ).signedTransaction}
      />
    </>
  );
}

function phaseCopy(phase: Exclude<Phase, 'failed' | 'ready'>): {
  readonly title: string;
  readonly text: string;
} {
  switch (phase) {
    case 'opening': return { title: 'Opening wallet', text: 'Preparing your secure wallet...' };
    case 'authenticating': return { title: 'Confirming Telegram', text: 'Matching this wallet to your Telegram account...' };
    case 'creating': return { title: 'Creating wallet', text: 'Privy is creating your Solana wallet...' };
    case 'linking': return { title: 'Verifying wallet', text: 'Signing an ownership message. No SOL is moving.' };
  }
}
