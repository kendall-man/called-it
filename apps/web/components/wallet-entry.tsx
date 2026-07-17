'use client';

import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { ArrowLeft } from 'lucide-react';
import { initializeTelegramWebApp, telegramInitDataFromWebApp } from '@/lib/telegram-web-app-client';
import type { WalletApplicationProps } from './wallet-application';
import { WalletButton, WalletState } from './wallet-ui';

const WalletApplication = dynamic(
  () => import('./wallet-application').then((module) => module.WalletApplication),
  {
    ssr: false,
    loading: () => (
      <WalletState
        title="Opening wallet"
        text="Loading secure wallet services..."
        loading
      />
    ),
  },
);

export function WalletEntry(props: Omit<WalletApplicationProps, 'telegramInitData'>) {
  const [launch, setLaunch] = useState<TelegramLaunch>({ kind: 'checking' });

  useEffect(() => {
    let dispose: (() => void) | null = null;
    const deadline = Date.now() + TELEGRAM_BRIDGE_TIMEOUT_MS;
    const checkBridge = () => {
      dispose ??= initializeTelegramWebApp(window);
      const initData = telegramInitDataFromWebApp(window);
      if (initData === null) return false;
      setLaunch({ kind: 'ready', initData });
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

  if (launch.kind === 'checking') {
    return <WalletState title="Opening in Telegram" text="Checking the private Telegram wallet link..." loading />;
  }
  if (launch.kind === 'unavailable') {
    return <ReturnToTelegramState botUsername={props.botUsername} />;
  }
  return (
    <WalletErrorBoundary botUsername={props.botUsername}>
      <WalletApplication {...props} telegramInitData={launch.initData} />
    </WalletErrorBoundary>
  );
}

type WalletErrorBoundaryState = { readonly failed: boolean };

class WalletErrorBoundary extends Component<
  { readonly children: ReactNode; readonly botUsername: string },
  WalletErrorBoundaryState
> {
  state: WalletErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): WalletErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('wallet_client_exception', {
      name: error.name,
      message: error.message,
      componentStack: info.componentStack,
    });
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <WalletState
        title="Wallet needs attention"
        text="The wallet screen stopped unexpectedly before wallet verification completed. Return to Telegram and open /wallet again."
        action={<ReturnToTelegramAction botUsername={this.props.botUsername} />}
      />
    );
  }
}

type TelegramLaunch =
  | { readonly kind: 'checking' }
  | { readonly kind: 'ready'; readonly initData: string }
  | { readonly kind: 'unavailable' };

const TELEGRAM_BRIDGE_TIMEOUT_MS = 4_000;
const TELEGRAM_BRIDGE_POLL_MS = 50;

function ReturnToTelegramState(props: { readonly botUsername: string }) {
  return (
    <WalletState
      title="Open this wallet in Telegram"
      text="This private wallet link must open from your Telegram chat. Return to Telegram and tap /wallet again."
      action={<ReturnToTelegramAction botUsername={props.botUsername} />}
    />
  );
}

function ReturnToTelegramAction(props: { readonly botUsername: string }) {
  const returnToTelegram = () => {
    if (props.botUsername.length > 0) {
      window.location.assign(`https://t.me/${encodeURIComponent(props.botUsername)}`);
    } else {
      window.history.back();
    }
  };
  return (
    <div className="mt-5">
      <WalletButton icon={<ArrowLeft size={18} />} onClick={returnToTelegram}>
        Return to Telegram
      </WalletButton>
    </div>
  );
}
