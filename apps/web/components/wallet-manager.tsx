'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  usePrivy,
  useSubscribeToJwtAuthWithFlag,
  useUser,
  type WalletWithMetadata,
} from '@privy-io/react-auth';
import {
  useSignMessage,
  useSignTransaction,
  useWallets,
  type ConnectedStandardSolanaWallet,
} from '@privy-io/react-auth/solana';
import { ArrowLeft } from 'lucide-react';
import {
  linkPrivyWallet,
  requestWalletAuthSession,
  walletClientErrorMessage,
} from '@/lib/wallet-client';
import { isPrivySolanaWalletAccount } from '@/lib/wallet-flow';
import { walletSessionTokenFromLocation } from '@/lib/wallet-session';
import { WalletDashboard } from './wallet-dashboard';
import { WalletButton, WalletState } from './wallet-ui';

type WalletManagerProps = {
  readonly network: 'devnet' | 'mainnet-beta';
  readonly rpcUrl: string;
  readonly treasuryPubkey: string;
  readonly botUsername: string;
  readonly custodyMode: 'legacy' | 'escrow';
  readonly canonicalUsdcMint?: string;
};

type SessionState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'failed'; readonly error: string }
  | { readonly kind: 'valid'; readonly token: string };

type Operation = 'idle' | 'linking' | 'ready' | 'failed';

const PRIVY_AUTH_TIMEOUT_MS = 25_000;
const WALLET_READY_TIMEOUT_MS = 25_000;

export function WalletManager(props: WalletManagerProps) {
  const { ready, authenticated, error: privyError, getAccessToken } = usePrivy();
  const { user } = useUser();
  const { ready: walletsReady, wallets } = useWallets();
  const { signMessage } = useSignMessage();
  const { signTransaction } = useSignTransaction();
  const [session, setSession] = useState<SessionState>({ kind: 'loading' });
  const [operation, setOperation] = useState<Operation>('idle');
  const [operationError, setOperationError] = useState('');
  const jwt = useRef<string | undefined>(undefined);
  const linkedAttempt = useRef('');

  const fail = useCallback((message: string) => {
    setOperationError(message);
    setOperation('failed');
  }, []);
  const handleJwtAuthError = useCallback(() => {
    fail('Secure wallet sign-in failed. Return to Telegram and open /wallet again.');
  }, [fail]);

  const getExternalJwt = useCallback(async () => jwt.current, []);
  const jwtAuth = useSubscribeToJwtAuthWithFlag({
    enabled: session.kind === 'valid',
    isAuthenticated: session.kind === 'valid',
    isLoading: session.kind === 'loading',
    getExternalJwt,
    onError: handleJwtAuthError,
  });

  const embeddedWalletAddress = user?.linkedAccounts.find((account): account is WalletWithMetadata => (
    isPrivySolanaWalletAccount(account)
  ))?.address ??
    null;
  const activeWallet = embeddedWalletAddress === null
    ? null
    : wallets.find((wallet) => wallet.address === embeddedWalletAddress) ?? null;

  useEffect(() => {
    let cancelled = false;
    const token = walletSessionTokenFromLocation(window.location);
    if (token === null) {
      setSession({ kind: 'invalid' });
      return;
    }
    void requestWalletAuthSession(token).then((authSession) => {
      if (cancelled) return;
      jwt.current = authSession.jwt;
      setSession({ kind: 'valid', token });
    }).catch((cause: unknown) => {
      if (cancelled) return;
      setSession({ kind: 'failed', error: walletClientErrorMessage(cause) });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (session.kind !== 'valid' || operation === 'failed' || operation === 'ready') return;
    if (jwtAuth.state.status === 'not-enabled') {
      const timeout = window.setTimeout(() => {
        fail('Secure wallet sign-in is not enabled for this app yet. Try again shortly.');
      }, 1_500);
      return () => window.clearTimeout(timeout);
    }
    if (jwtAuth.state.status === 'error') {
      fail('Secure wallet sign-in failed. Return to Telegram and open /wallet again.');
      return;
    }
    if (jwtAuth.state.status === 'done' && ready && authenticated) return;
    const timeout = window.setTimeout(() => {
      fail('Secure wallet sign-in took too long. Return to Telegram and open /wallet again.');
    }, PRIVY_AUTH_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [authenticated, fail, jwtAuth.state.status, operation, ready, session]);

  useEffect(() => {
    if (privyError === null) return;
    fail('Secure wallet services could not start. Return to Telegram and try again.');
  }, [fail, privyError]);

  useEffect(() => {
    if (
      session.kind !== 'valid' || jwtAuth.state.status !== 'done' ||
      !ready || !authenticated || operation !== 'idle' ||
      (walletsReady && activeWallet !== null)
    ) return;
    const timeout = window.setTimeout(() => {
      fail('Privy could not open the Solana wallet. Return to Telegram and try again.');
    }, WALLET_READY_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [activeWallet, authenticated, fail, jwtAuth.state.status, operation, ready, session, walletsReady]);

  const verifyWallet = useCallback(async (
    wallet: ConnectedStandardSolanaWallet,
    token: string,
  ) => {
    const attempt = `${token}:${wallet.address}`;
    if (linkedAttempt.current === attempt) return;
    linkedAttempt.current = attempt;
    setOperation('linking');
    setOperationError('');
    try {
      const accessToken = await getAccessToken();
      if (accessToken === null) throw new Error('Privy access token unavailable');
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
      setOperation('ready');
    } catch (cause) {
      fail(walletClientErrorMessage(cause));
    }
  }, [fail, getAccessToken, signMessage]);

  useEffect(() => {
    if (
      session.kind !== 'valid' || jwtAuth.state.status !== 'done' ||
      !authenticated || !walletsReady || activeWallet === null || operation === 'failed'
    ) return;
    void verifyWallet(activeWallet, session.token);
  }, [activeWallet, authenticated, jwtAuth.state.status, operation, session, verifyWallet, walletsReady]);

  if (session.kind === 'loading') {
    return <WalletState title="Opening wallet" text="Checking this private wallet link..." loading />;
  }
  if (session.kind === 'invalid') {
    return <FailureState error="Send /wallet to Called It in a private chat, then tap Create or manage wallet." botUsername={props.botUsername} />;
  }
  if (session.kind === 'failed') {
    return <FailureState error={session.error} botUsername={props.botUsername} />;
  }
  if (operation === 'failed') {
    return <FailureState error={operationError} botUsername={props.botUsername} />;
  }
  if (operation !== 'ready') {
    if (operation === 'linking') {
      return <WalletState title="Verifying wallet" text="Confirming ownership. No SOL is moving." loading />;
    }
    return <WalletState title="Opening wallet" text="Confirming your private wallet session..." loading />;
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
          await signTransaction({
            transaction,
            wallet: activeWallet,
            chain,
            options: { uiOptions: { showWalletUIs: false } },
          })
        ).signedTransaction}
      />
    </>
  );
}

function FailureState(props: { readonly error: string; readonly botUsername: string }) {
  const returnToTelegram = () => {
    if (props.botUsername.length === 0) {
      window.history.back();
      return;
    }
    window.location.assign(`https://t.me/${encodeURIComponent(props.botUsername)}`);
  };
  return (
    <WalletState
      title="Wallet needs attention"
      text={props.error}
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
