import { formatUtc } from '@/lib/format';
import type { TimelineStep } from '@/lib/timeline';
import { cx } from '@/lib/cx';

const DOT_STYLES: Record<TimelineStep['state'], string> = {
  done: 'border-pitch-500 bg-pitch-500/20 text-pitch-300',
  current: 'border-flood-500 bg-flood-500/20 text-flood-300 animate-pulse',
  upcoming: 'border-line bg-night-800 text-fog',
};

const DOT_GLYPHS: Record<TimelineStep['state'], string> = {
  done: '✓',
  current: '●',
  upcoming: '·',
};

export function TimelineList({ steps }: { steps: TimelineStep[] }) {
  return (
    <ol className="space-y-0">
      {steps.map((step, index) => (
        <li key={step.key} className="relative flex gap-3 pb-5 last:pb-0">
          {index < steps.length - 1 ? (
            <span
              aria-hidden
              className="absolute left-[11px] top-6 h-[calc(100%-1.25rem)] w-px bg-line"
            />
          ) : null}
          <span
            aria-hidden
            className={cx(
              'z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold',
              DOT_STYLES[step.state],
            )}
          >
            {DOT_GLYPHS[step.state]}
          </span>
          <div className="min-w-0">
            <p
              className={cx(
                'text-sm font-bold',
                step.state === 'upcoming' ? 'text-fog' : 'text-chalk',
              )}
            >
              {step.label}
              {step.at ? (
                <span className="ml-2 text-xs font-normal text-fog">{formatUtc(step.at)}</span>
              ) : null}
            </p>
            {step.detail ? <p className="mt-0.5 text-xs text-fog">{step.detail}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
