/**
 * Derives the receipt page's status timeline from a market's status +
 * settlement columns. Pure; copy stays in the game-show register.
 */
import type { ReceiptCurrency, ReceiptOutcome, ReceiptStatus } from './receipts';

export type StepState = 'done' | 'current' | 'upcoming';

export interface TimelineStep {
  key: 'called' | 'live' | 'settled';
  label: string;
  detail: string | null;
  state: StepState;
  /** ISO timestamp shown next to the step, when known. */
  at: string | null;
}

export interface TimelineInput {
  status: ReceiptStatus;
  createdAt: string;
  settledAt: string | null;
  outcome: ReceiptOutcome | null;
  currency?: ReceiptCurrency;
}

const LIVE_STEP_COPY: Record<Exclude<ReceiptStatus, 'settled' | 'voided'>, [string, string]> = {
  pending_lineup: ['Waiting on lineups', 'Named a player — the call activates when the teamsheet drops'],
  open: ['Calls open', 'Stakes matched in SOL — every multiplier locked at tap time'],
  frozen: ['Calls locked', 'Drama on the pitch — nobody moves until it clears'],
  settling: ['Moment of truth', 'Deciding stat confirmed — sealing the result'],
};

const OUTCOME_COPY: Record<ReceiptOutcome, string> = {
  claim_won: 'Settled — called it',
  claim_lost: 'Settled — didn’t land',
  void: 'Settled — void, stakes returned',
};

export function buildTimeline(input: TimelineInput): TimelineStep[] {
  const called: TimelineStep = {
    key: 'called',
    label: 'Call made',
    detail: 'Terms confirmed by the claimer — on the record',
    state: 'done',
    at: input.createdAt,
  };

  if (input.status === 'settled') {
    return [
      called,
      { key: 'live', label: 'Calls locked', detail: null, state: 'done', at: null },
      {
        key: 'settled',
        label: input.outcome ? OUTCOME_COPY[input.outcome] : 'Settled',
        detail: 'Straight from the verified feed — no arguments',
        state: 'done',
        at: input.settledAt,
      },
    ];
  }

  if (input.status === 'voided') {
    return [
      called,
      { key: 'live', label: 'Calls locked', detail: null, state: 'done', at: null },
      {
        key: 'settled',
        label: 'Voided — stakes returned',
        detail: 'The match had other plans; every stake comes back',
        state: 'done',
        at: input.settledAt,
      },
    ];
  }

  const [liveLabel, defaultLiveDetail] = LIVE_STEP_COPY[input.status];
  const liveDetail = input.status === 'open'
    ? `Positions matched in ${(input.currency ?? 'sol').toUpperCase()} — every multiplier locked at tap time`
    : defaultLiveDetail;
  return [
    called,
    { key: 'live', label: liveLabel, detail: liveDetail, state: 'current', at: null },
    {
      key: 'settled',
      label: 'Settlement',
      detail: 'Lands seconds after the deciding stat is confirmed',
      state: 'upcoming',
      at: null,
    },
  ];
}
