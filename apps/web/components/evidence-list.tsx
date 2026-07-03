import type { EvidenceFact } from '@/lib/receipts';
import { Badge } from './ui';
import { cx } from '@/lib/cx';

/** Feed-event kinds → spectator copy. Unknown kinds fall back to the raw kind. */
const KIND_COPY: Record<string, string> = {
  goal: 'Goal',
  goal_amended: 'Goal amended',
  goal_discarded: 'Goal chalked off',
  card: 'Card shown',
  var_check: 'VAR check',
  var_end: 'VAR resolved',
  phase_change: 'Phase change',
  lineup: 'Lineups in',
  possible_event: 'Something brewing',
  odds_suspension: 'Data pause',
  coverage_warning: 'Coverage wobble',
  stat_update: 'Stat update',
  other: 'Feed note',
};

const GOAL_TYPE_COPY: Record<string, string> = {
  head: 'header',
  shot: 'shot',
  own_goal: 'own goal',
  penalty: 'from the spot',
  other: '',
};

function factLabel(fact: EvidenceFact): string {
  const kind = KIND_COPY[fact.kind] ?? fact.kind;
  const scorer = fact.playerName ? ` — ${fact.playerName}` : '';
  const flourish =
    fact.goalType && GOAL_TYPE_COPY[fact.goalType]
      ? ` (${GOAL_TYPE_COPY[fact.goalType]})`
      : '';
  return `${kind}${scorer}${flourish}`;
}

export function EvidenceList({
  facts,
  decidingSeq,
}: {
  facts: EvidenceFact[];
  decidingSeq: number | null;
}) {
  if (facts.length === 0) {
    return (
      <p className="text-sm text-fog">
        Evidence lands here as the match talks — derived facts only, straight from the verified
        feed.
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
              <p className="truncate text-sm font-semibold text-chalk">{factLabel(fact)}</p>
              <p className="text-[11px] text-fog">
                seq {fact.seq} · {fact.confirmed ? 'confirmed' : 'unconfirmed'}
              </p>
            </div>
            {isDecider ? <Badge tone="pitch">The decider</Badge> : null}
          </li>
        );
      })}
    </ul>
  );
}
