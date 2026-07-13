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
        'rounded-2xl border border-line bg-night-900/80 p-5 shadow-[0_1px_0_0_rgb(255_255_255/0.04)_inset]',
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
        'display-type text-sm tracking-[0.18em] text-fog',
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
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider',
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
      className="display-type text-lg tracking-tight text-chalk focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pitch-300"
    >
      Called&nbsp;<span className="text-pitch-400">It</span>
      <span aria-hidden className="ml-1 text-pitch-400">
        ✓
      </span>
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
        'mx-auto flex min-h-dvh w-full flex-col px-4 pb-14 pt-5 sm:px-6',
        width === 'board' ? 'max-w-5xl' : 'max-w-xl',
      )}
    >
      <header className="mb-6 flex items-center justify-between">
        <Wordmark />
        {topRight}
      </header>
      <main className="flex flex-1 flex-col gap-4">{children}</main>
      <footer className="mt-10 space-y-1 text-center text-xs text-fog/80">
        <p>
          {mainnet
            ? 'SOL positions settle on Solana mainnet.'
            : 'Played in devnet SOL — test tokens, not real money.'}
        </p>
        <p>Match data by TxLINE · proofs on Solana {mainnet ? 'mainnet' : 'devnet'}.</p>
      </footer>
    </div>
  );
}
