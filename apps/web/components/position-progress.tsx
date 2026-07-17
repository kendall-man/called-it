'use client';

import { CheckCircle2, Circle, LoaderCircle } from 'lucide-react';
import type { PositionProgressModel, PositionStepStatus } from '@/lib/position-stepper';

const STATUS_TEXT: Readonly<Record<PositionStepStatus, string>> = {
  done: 'Done',
  current: 'Now',
  upcoming: 'Next',
};

export function PositionProgress(props: { readonly model: PositionProgressModel }) {
  return (
    <ol className="mt-5 space-y-2 text-left" aria-label="Position progress" aria-live="polite">
      {props.model.steps.map((step) => (
        <li
          key={step.id}
          className="flex min-h-11 items-center gap-3 rounded-lg border border-line bg-night-800 px-3"
        >
          <StepIcon status={step.status} />
          <span className={`text-sm font-semibold ${step.status === 'upcoming' ? 'text-fog' : 'text-chalk'}`}>
            {step.label}
          </span>
          <span className="ml-auto text-xs font-semibold uppercase text-fog">
            {STATUS_TEXT[step.status]}
          </span>
        </li>
      ))}
    </ol>
  );
}

function StepIcon(props: { readonly status: PositionStepStatus }) {
  if (props.status === 'done') {
    return <CheckCircle2 aria-hidden className="shrink-0 text-pitch-300" size={18} />;
  }
  if (props.status === 'current') {
    return <LoaderCircle aria-hidden className="shrink-0 animate-spin text-flood-300" size={18} />;
  }
  return <Circle aria-hidden className="shrink-0 text-fog/60" size={18} />;
}
