import { describeEvidenceFact, type EvidenceFact } from '@/lib/receipts';
import { Badge } from './ui';
import { cx } from '@/lib/cx';

export type EvidenceState = 'ready' | 'not_ready' | 'unavailable';

export function EvidenceList({
  facts,
  decidingSeq,
  state = 'ready',
}: {
  facts: readonly EvidenceFact[];
  decidingSeq: number | null;
  state?: EvidenceState;
}) {
  if (state === 'unavailable') {
    return (
      <p className="text-sm leading-relaxed text-fog">
        Public evidence details are unavailable right now. The recorded outcome and SOL totals have
        not changed.
      </p>
    );
  }
  if (state === 'not_ready' || facts.length === 0) {
    return (
      <p className="text-sm text-fog">
        No deciding event is recorded yet. Evidence appears after the match is settled.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-line/60">
      {facts.map((fact) => {
        const isDecider = decidingSeq !== null && fact.seq === decidingSeq;
        return (
          <li key={fact.seq} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
            <span
              className={cx(
                'display-type w-12 shrink-0 text-right text-lg',
                isDecider ? 'text-pitch-300' : 'text-chalk',
              )}
            >
              {fact.minute !== null ? `${fact.minute}′` : '—'}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-chalk">{describeEvidenceFact(fact)}</p>
              <p className="text-[11px] text-fog">
                Feed sequence {fact.seq} - {fact.confirmed ? 'confirmed' : 'not yet confirmed'}
              </p>
            </div>
            {isDecider ? <Badge tone="pitch">The decider</Badge> : null}
          </li>
        );
      })}
    </ul>
  );
}
