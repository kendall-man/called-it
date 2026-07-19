'use client';

import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { ArrowLeft } from 'lucide-react';
import { initializeTelegramWebApp, telegramInitDataFromWebApp } from '@/lib/telegram-web-app-client';
import type { PositionManagerProps } from './position-manager';
import { WalletButton, WalletState } from './wallet-ui';

const PositionApplication = dynamic(
  () => import('./position-application').then((module) => module.PositionApplication),
  {
    ssr: false,
    loading: () => (
      <WalletState title="Opening your pick" text="Loading wallet approval..." loading />
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
const TELEGRAM_BRIDGE_POLL_MS = 50;

export function PositionEntry(props: PositionEntryProps) {
  const [launch, setLaunch] = useState<TelegramLaunch>({ kind: 'checking' });

  useEffect(() => {
    let dispose: (() => void) | null = null;
    const deadline = Date.now() + TELEGRAM_BRIDGE_TIMEOUT_MS;
    const checkBridge = () => {
      dispose ??= initializeTelegramWebApp(window);
      const initData = telegramInitDataFromWebApp(window);
      if (initData !== null) {
        setLaunch({ kind: 'ready', initData });
        return true;
      }
      return false;
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

  return (
    <>
      {launch.kind === 'checking' ? (
        <WalletState title="Opening in Telegram" text="Checking this Telegram approval..." loading />
      ) : launch.kind === 'unavailable' ? (
        <WalletState
          title="Open this approval in Telegram"
          text="Open this from your private Telegram chat. No SOL moved and no pick was made. Go back and tap Review and sign again."
          action={props.botUsername.length > 0 ? (
            <a
              className="mt-5 flex min-h-12 w-full items-center justify-center bg-pitch-400 px-4 font-mono text-sm font-medium text-night-950 hover:bg-pitch-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pitch-300"
              href={`https://t.me/${encodeURIComponent(props.botUsername)}`}
            >
              Return to Telegram
            </a>
          ) : undefined}
        />
      ) : (
        <PositionErrorBoundary botUsername={props.botUsername}>
          <PositionApplication {...props} telegramInitData={launch.initData} />
        </PositionErrorBoundary>
      )}
    </>
  );
}
type PositionErrorBoundaryProps = { readonly children: ReactNode; readonly botUsername: string };
type PositionErrorBoundaryState = { readonly failed: boolean };

class PositionErrorBoundary extends Component<
  PositionErrorBoundaryProps,
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
    // Recover by returning to Telegram for a fresh approval, never by
    // reloading: a reload reuses the same short-lived link, whose blockhash
    // and session have almost certainly expired by now, so it dead-ends on
    // "Approval link expired". A fresh Review and sign is the only path that
    // can succeed.
    return (
      <WalletState
        title="Position needs attention"
        text="This screen closed before confirmation. No pick was made. Go back to Telegram and tap Review and sign again."
        action={this.props.botUsername.length > 0 ? (
          <a
            className="mt-5 flex min-h-12 w-full items-center justify-center bg-pitch-400 px-4 font-mono text-sm font-medium text-night-950 hover:bg-pitch-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pitch-300"
            href={`https://t.me/${encodeURIComponent(this.props.botUsername)}`}
          >
            Return to Telegram
          </a>
        ) : (
          <div className="mt-5">
            <WalletButton icon={<ArrowLeft size={18} />} onClick={() => window.history.back()}>
              Return to Telegram
            </WalletButton>
          </div>
        )}
      />
    );
  }
}
