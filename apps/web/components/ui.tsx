/**
 * Hand-written shadcn-idiom primitives — small, composable, class-driven.
 * No CLI, no runtime deps beyond React + Tailwind.
 */
import type { ReactNode } from 'react';
import Link from 'next/link';
import { cx } from '@/lib/cx';
import { isMainnet } from '@/lib/solana-network';

// ── Card ──────────────────────────────────────────────────────────────────

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <section
      className={cx(
        'border border-line bg-night-900/90 p-5 shadow-[0_1px_0_0_rgb(255_255_255/0.04)_inset]',
        className,
      )}
    >
      {children}
    </section>
  );
}

export function SectionTitle({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <h2
      className={cx(
        'font-mono text-xs font-medium uppercase tracking-[0.12em] text-fog',
        className,
      )}
    >
      {children}
    </h2>
  );
}

// ── Badges & chips ────────────────────────────────────────────────────────

export type BadgeTone = 'pitch' | 'flood' | 'siren' | 'sky' | 'neutral';

const BADGE_TONES: Record<BadgeTone, string> = {
  pitch: 'border-pitch-500/40 bg-pitch-500/15 text-pitch-300',
  flood: 'border-flood-500/40 bg-flood-500/15 text-flood-300',
  siren: 'border-siren-500/40 bg-siren-500/15 text-siren-300',
  sky: 'border-sky-400/40 bg-sky-400/15 text-sky-400',
  neutral: 'border-line bg-night-800 text-fog',
};

export function Badge({
  tone = 'neutral',
  className,
  children,
}: {
  tone?: BadgeTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 border px-2.5 py-1 font-mono text-xs font-medium uppercase tracking-[0.08em]',
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

// ── Page chrome ───────────────────────────────────────────────────────────

export function Wordmark() {
  return (
    <Link
      href="/"
      className="text-xl font-semibold text-chalk focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pitch-300"
    >
      Rumble<span aria-hidden className="font-bold text-pitch-400">.</span>
    </Link>
  );
}

export function PageShell({
  topRight,
  children,
  width = 'reading',
}: {
  topRight?: ReactNode;
  children: ReactNode;
  width?: 'reading' | 'board';
}) {
  const mainnet = isMainnet();
  return (
    <div
      className={cx(
        'rumble-product-shell mx-auto flex min-h-dvh w-full flex-col px-4 sm:px-6',
        width === 'board' ? 'max-w-5xl' : 'max-w-xl',
      )}
      style={{
        paddingTop: 'max(1.25rem, calc(1.25rem + var(--tg-content-safe-area-top, 0px)))',
        paddingBottom: 'max(3.5rem, calc(3.5rem + var(--tg-content-safe-area-bottom, 0px)))',
      }}
    >
      <header className="mb-6 flex items-center justify-between">
        <Wordmark />
        {topRight}
      </header>
      <main className="flex flex-1 flex-col gap-4">{children}</main>
      <footer className="mt-12 space-y-1 border-t border-line pt-5 text-center text-xs text-fog">
        <p>
          {mainnet
            ? 'Payments settle on Solana mainnet.'
            : 'Public beta · Solana devnet only.'}
        </p>
        <p>
          Match results by{' '}
          <a
            href="https://txodds.net/our-products/tx-line/"
            target="_blank"
            rel="noreferrer"
            className="text-pitch-300 underline underline-offset-4 hover:text-pitch-400"
          >
            TxLINE
          </a>
          . Payments on Solana {mainnet ? 'mainnet' : 'devnet'}.
        </p>
      </footer>
    </div>
  );
}
