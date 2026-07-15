'use client';

import { Component, useCallback, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import Script from 'next/script';
import { RefreshCw } from 'lucide-react';
import { telegramInitDataFromWebApp } from '@/lib/telegram-web-app-client';
import type { PositionManagerProps } from './position-manager';
import { WalletButton, WalletState } from './wallet-ui';

const PositionApplication = dynamic(
  () => import('./position-application').then((module) => module.PositionApplication),
  {
    ssr: false,
    loading: () => (
      <WalletState title="Opening position" text="Loading secure wallet approval..." loading />
    ),
  },
);

type PositionEntryProps = Omit<PositionManagerProps, 'telegramInitData'> & {
  readonly appId: string;
};

type TelegramLaunch =
  | { readonly kind: 'checking' }
  | { readonly kind: 'ready'; readonly initData: string }
  | { readonly kind: 'unavailable' };

const TELEGRAM_BRIDGE_TIMEOUT_MS = 4_000;

export function PositionEntry(props: PositionEntryProps) {
  const [launch, setLaunch] = useState<TelegramLaunch>({ kind: 'checking' });
  const readBridge = useCallback(() => {
    const initData = telegramInitDataFromWebApp(window);
    setLaunch(initData === null
      ? { kind: 'unavailable' }
      : { kind: 'ready', initData });
  }, []);

  useEffect(() => {
    const initData = telegramInitDataFromWebApp(window);
    if (initData !== null) {
      setLaunch({ kind: 'ready', initData });
      return;
    }
    const timeout = window.setTimeout(
      () => setLaunch({ kind: 'unavailable' }),
      TELEGRAM_BRIDGE_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timeout);
  }, []);

  return (
    <>
      <Script
        src="https://telegram.org/js/telegram-web-app.js"
        strategy="afterInteractive"
        onReady={readBridge}
        onError={() => setLaunch({ kind: 'unavailable' })}
      />
      {launch.kind === 'checking' ? (
        <WalletState title="Opening in Telegram" text="Checking the private Telegram approval..." loading />
      ) : launch.kind === 'unavailable' ? (
        <WalletState
          title="Open this approval in Telegram"
          text="This approval must open from your private Telegram chat. No assets moved and no position was created. Return to Telegram and tap Review and sign again."
          action={props.botUsername.length > 0 ? (
            <a
              className="mt-5 flex min-h-12 w-full items-center justify-center rounded-lg bg-pitch-400 px-4 text-sm font-bold text-night-950 hover:bg-pitch-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pitch-300"
              href={`https://t.me/${encodeURIComponent(props.botUsername)}`}
            >
              Return to Telegram
            </a>
          ) : undefined}
        />
      ) : (
        <PositionErrorBoundary>
          <PositionApplication {...props} telegramInitData={launch.initData} />
        </PositionErrorBoundary>
      )}
    </>
  );
}
type PositionErrorBoundaryState = { readonly failed: boolean };

class PositionErrorBoundary extends Component<
  { readonly children: ReactNode },
  PositionErrorBoundaryState
> {
  state: PositionErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): PositionErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    console.error('position_client_exception');
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <WalletState
        title="Position needs attention"
        text="The approval screen stopped before confirmation. No new position was confirmed. Reload the secure link."
        action={(
          <div className="mt-5">
            <WalletButton icon={<RefreshCw size={18} />} onClick={() => window.location.reload()}>
              Reload approval
            </WalletButton>
          </div>
        )}
      />
    );
  }
}
