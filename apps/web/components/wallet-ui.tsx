import { Check, Copy, LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card } from '@/components/ui';

export const walletInputClass = 'min-h-12 w-full rounded-lg border border-line bg-night-800 px-3 py-2 text-base text-chalk outline-none placeholder:text-fog/60 focus:border-pitch-400 focus:ring-2 focus:ring-pitch-400/20';

export function WalletHeading(props: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly subtitle: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-pitch-500/15 text-pitch-300">
        {props.icon}
      </span>
      <div className="min-w-0">
        <h2 className="text-lg font-bold text-chalk">{props.title}</h2>
        <p className="text-sm leading-5 text-fog">{props.subtitle}</p>
      </div>
    </div>
  );
}

export function WalletState(props: {
  readonly title: string;
  readonly text: string;
  readonly loading?: boolean;
  readonly action?: ReactNode;
}) {
  return (
    <Card className="rounded-lg text-center">
      {props.loading && <LoaderCircle className="mx-auto mb-4 animate-spin text-pitch-300" size={28} />}
      <h1 className="text-xl font-bold text-chalk">{props.title}</h1>
      <p className="mt-2 text-sm leading-6 text-fog">{props.text}</p>
      {props.action}
    </Card>
  );
}

export function WalletStatus(props: {
  readonly tone: 'error' | 'success';
  readonly children: ReactNode;
}) {
  const color = props.tone === 'error'
    ? 'border-siren-500/40 bg-siren-500/10 text-siren-300'
    : 'border-pitch-500/40 bg-pitch-500/10 text-pitch-300';
  return <div role="status" className={`rounded-lg border p-4 text-sm leading-6 ${color}`}>{props.children}</div>;
}

export function WalletButton(props: {
  readonly children: ReactNode;
  readonly icon: ReactNode;
  readonly disabled?: boolean;
  readonly type?: 'button' | 'submit';
  readonly onClick?: () => void;
}) {
  return (
    <button
      type={props.type ?? 'button'}
      disabled={props.disabled}
      onClick={props.onClick}
      className="flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-pitch-400 px-4 text-sm font-bold text-night-950 hover:bg-pitch-300 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pitch-300"
    >
      {props.icon}{props.children}
    </button>
  );
}

export function WalletValue(props: {
  readonly label: string;
  readonly value: string;
  readonly copied: boolean;
  readonly onCopy: () => void;
}) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase text-fog">{props.label}</p>
      <div className="mt-2 flex items-start gap-2">
        <button type="button" className="min-w-0 flex-1 break-all text-left font-mono text-sm leading-6 text-sky-400" onClick={props.onCopy}>
          {props.value}
        </button>
        <button type="button" title={`Copy ${props.label}`} className="grid size-11 shrink-0 place-items-center rounded-lg border border-line text-fog hover:bg-night-800" onClick={props.onCopy}>
          {props.copied ? <Check size={18} /> : <Copy size={18} />}
        </button>
      </div>
    </div>
  );
}
