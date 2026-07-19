'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, RefreshCw, WalletCards, X } from 'lucide-react';
import { MINIAPP_POSITION_START_PARAM_PATTERN } from '@/lib/miniapp-contract';
import {
  MiniAppClientError,
  requestMiniAppPositionSession,
  requestMiniAppWalletSession,
} from '@/lib/miniapp-client';
import { miniAppOpenFailure, type MiniAppOpenSurface } from '@/lib/miniapp-flow';
import {
  closeTelegramWebApp,
  initializeTelegramWebApp,
  telegramInitDataFromWebApp,
  telegramStartParamFromWebApp,
} from '@/lib/telegram-web-app-client';
import { Card } from './ui';
import { PositionEntry } from './position-entry';
import { WalletEntry } from './wallet-entry';
import { WalletButton, WalletState } from './wallet-ui';

export type MiniAppEntryProps = {
  readonly appId: string;
  readonly botUsername: string;
  readonly canonicalUsdcMint: string;
  readonly escrowGenesisHash?: string;
  readonly network: 'devnet' | 'mainnet-beta';
  readonly programId: string;
  readonly rpcUrl: string;
  readonly treasuryPubkey: string;
};

type TelegramLaunch =
  | { readonly kind: 'checking' }
  | { readonly kind: 'ready'; readonly initData: string; readonly positionLaunch: boolean }
  | { readonly kind: 'unavailable' };

type EntryPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'position-opening' }
  | { readonly kind: 'position'; readonly token: string }
  | { readonly kind: 'wallet-needed' }
  | { readonly kind: 'wallet-opening' }
  | { readonly kind: 'wallet'; readonly token: string }
  | { readonly kind: 'failed'; readonly surface: MiniAppOpenSurface; readonly code: string };

const TELEGRAM_BRIDGE_TIMEOUT_MS = 4_000;
const TELEGRAM_BRIDGE_POLL_MS = 50;

export function MiniAppEntry(props: MiniAppEntryProps) {
  const [launch, setLaunch] = useState<TelegramLaunch>({ kind: 'checking' });
  const [phase, setPhase] = useState<EntryPhase>({ kind: 'idle' });
  const [walletLinked, setWalletLinked] = useState(false);

  useEffect(() => {
    let dispose: (() => void) | null = null;
    const deadline = Date.now() + TELEGRAM_BRIDGE_TIMEOUT_MS;
    const checkBridge = () => {
      dispose ??= initializeTelegramWebApp(window);
      const initData = telegramInitDataFromWebApp(window);
      if (initData === null) return false;
      // Client-parsed param routes the flow only; the server re-parses the
      // signed initData before the engine mints anything.
      const startParam = telegramStartParamFromWebApp(window) ??
        new URLSearchParams(window.location.search).get('tgWebAppStartParam');
      setLaunch({
        kind: 'ready',
        initData,
        positionLaunch: startParam !== null && MINIAPP_POSITION_START_PARAM_PATTERN.test(startParam),
      });
      return true;
    };
    if (checkBridge()) return () => dispose?.();
    const interval = window.setInterval(() => {
      if (checkBridge() || Date.now() >= deadline) {
        window.clearInterval(interval);
        if (Date.now() >= deadline) setLaunch({ kind: 'unavailable' });
      }
    }, TELEGRAM_BRIDGE_POLL_MS);
    return () => {
      window.clearInterval(interval);
      dispose?.();
    };
  }, []);

  const openPosition = useCallback(async (initData: string) => {
    setPhase({ kind: 'position-opening' });
    try {
      const session = await requestMiniAppPositionSession(initData);
      setPhase({ kind: 'position', token: session.token });
    } catch (cause) {
      const code = openErrorCode(cause);
      setPhase(code === 'wallet_required'
        ? { kind: 'wallet-needed' }
        : { kind: 'failed', surface: 'position', code });
    }
  }, []);

  const openWallet = useCallback(async (initData: string) => {
    setPhase({ kind: 'wallet-opening' });
    try {
      const session = await requestMiniAppWalletSession(initData);
      setPhase({ kind: 'wallet', token: session.token });
    } catch (cause) {
      setPhase({ kind: 'failed', surface: 'wallet', code: openErrorCode(cause) });
    }
  }, []);

  useEffect(() => {
    if (launch.kind !== 'ready' || phase.kind !== 'idle') return;
    if (launch.positionLaunch) {
      void openPosition(launch.initData);
    } else {
      void openWallet(launch.initData);
    }
  }, [launch, openPosition, openWallet, phase.kind]);

  const closeOrReturn = useCallback(() => {
    if (closeTelegramWebApp(window)) return;
    if (props.botUsername.length > 0) {
      window.location.assign(`https://t.me/${encodeURIComponent(props.botUsername)}`);
    } else {
      window.history.back();
    }
  }, [props.botUsername]);

  if (launch.kind === 'checking') {
    return <WalletState title="Opening in Telegram" text="Checking your Telegram session..." loading />;
  }
  if (launch.kind === 'unavailable') {
    return (
      <WalletState
        title="Open this in Telegram"
        text="This screen only works inside Telegram. No SOL moved and nothing changed. Return to Telegram and tap the button on the card again."
        action={props.botUsername.length > 0 ? (
          <a
            className="mt-5 flex min-h-12 w-full items-center justify-center bg-pitch-400 px-4 font-mono text-sm font-medium text-night-950 hover:bg-pitch-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pitch-300"
            href={`https://t.me/${encodeURIComponent(props.botUsername)}`}
          >
            Return to Telegram
          </a>
        ) : undefined}
      />
    );
  }

  if (phase.kind === 'idle' || phase.kind === 'position-opening') {
    return <WalletState title="Opening your call" text="Preparing your approval..." loading />;
  }
  if (phase.kind === 'wallet-opening') {
    return <WalletState title="Opening wallet" text="Preparing your wallet link..." loading />;
  }
  if (phase.kind === 'position') {
    return (
      <PositionEntry
        key={phase.token}
        appId={props.appId}
        botUsername={props.botUsername}
        canonicalUsdcMint={props.canonicalUsdcMint}
        network={props.network}
        programId={props.programId}
        rpcUrl={props.rpcUrl}
        token={phase.token}
      />
    );
  }
  if (phase.kind === 'wallet-needed') {
    return (
      <WalletState
        title="Set up your wallet first"
        text="Your Telegram account needs a wallet before you can make this pick. No SOL moved. Set it up below; you only do this once."
        action={(
          <div className="mt-5">
            <WalletButton icon={<WalletCards size={18} />} onClick={() => void openWallet(launch.initData)}>
              Set up wallet
            </WalletButton>
          </div>
        )}
      />
    );
  }
  if (phase.kind === 'wallet') {
    return (
      <>
        {walletLinked && launch.positionLaunch && (
          <Card>
            <p role="status" className="text-sm leading-6 text-fog">
              Your wallet is ready. You can now return to your call and approve it.
            </p>
            <div className="mt-3">
              <WalletButton icon={<ArrowLeft size={18} />} onClick={() => void openPosition(launch.initData)}>
                Back to your call
              </WalletButton>
            </div>
          </Card>
        )}
        <WalletEntry
          appId={props.appId}
          network={props.network}
          rpcUrl={props.rpcUrl}
          treasuryPubkey={props.treasuryPubkey}
          botUsername={props.botUsername}
          custodyMode="escrow"
          escrowProgramId={props.programId}
          canonicalUsdcMint={props.canonicalUsdcMint}
          escrowGenesisHash={props.escrowGenesisHash}
          sessionToken={phase.token}
          onLinked={() => setWalletLinked(true)}
        />
      </>
    );
  }

  const failure = miniAppOpenFailure(phase.code, phase.surface);
  const retryIsFresh = telegramInitDataAgeSeconds(launch.initData) < 240;
  const retry = phase.surface === 'wallet' || !launch.positionLaunch
    ? () => void openWallet(launch.initData)
    : () => void openPosition(launch.initData);
  const canRetry = failure.action === 'retry' && retryIsFresh;
  return (
    <WalletState
      title={failure.title}
      text={failure.text}
      action={(
        <div className="mt-5">
          <WalletButton
            icon={canRetry ? <RefreshCw size={18} /> : <X size={18} />}
            onClick={canRetry ? retry : closeOrReturn}
          >
            {canRetry ? failure.actionLabel : 'Return to Telegram'}
          </WalletButton>
        </div>
      )}
    />
  );
}

/** Routing-only freshness check; the server still authenticates the HMAC. */
function telegramInitDataAgeSeconds(initData: string): number {
  const authDate = Number(new URLSearchParams(initData).get('auth_date'));
  if (!Number.isSafeInteger(authDate) || authDate <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor(Date.now() / 1_000) - authDate);
}

function openErrorCode(cause: unknown): string {
  return cause instanceof MiniAppClientError ? cause.code : 'sponsor_unavailable';
}
