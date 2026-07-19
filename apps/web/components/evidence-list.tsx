import React from 'react';
import { describeEvidenceFact, type EvidenceFact } from '../lib/receipts';
import { Badge } from './ui';
import { cx } from '../lib/cx';

export type EvidenceState = 'ready' | 'not_ready' | 'not_recorded' | 'unavailable';

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
        Match events are unavailable right now. The result and totals have not changed.
      </p>
    );
  }
  if (state === 'not_ready' || facts.length === 0) {
    if (state === 'not_recorded') {
      return (
        <p className="text-sm text-fog">
          This finalized replay has no public deciding-event record. Its on-chain outcome and aggregate
          totals are shown above.
        </p>
      );
    }
    return (
      <p className="text-sm text-fog">
        No deciding event yet. Match events appear after Rumble settles the call.
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
                {fact.confirmed ? 'Confirmed match event' : 'Waiting for confirmation'}
              </p>
            </div>
            {isDecider ? <Badge tone="pitch">Deciding event</Badge> : null}
          </li>
        );
      })}
    </ul>
  );
}
