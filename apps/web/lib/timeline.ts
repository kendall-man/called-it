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
  pending_lineup: ['Waiting for lineups', 'This call opens when the team sheet is out'],
  open: ['Picks open', 'The group can pick yes or no'],
  frozen: ['Picks closed', 'Rumble is waiting for the final result'],
  settling: ['Checking the result', 'The deciding match event is confirmed'],
};

const OUTCOME_COPY: Record<ReceiptOutcome, string> = {
  claim_won: 'Yes won',
  claim_lost: 'No won',
  void: 'Call cancelled · SOL returned',
};

export function buildTimeline(input: TimelineInput): TimelineStep[] {
  const called: TimelineStep = {
    key: 'called',
    label: 'Call made',
    detail: 'The prediction was posted to the group',
    state: 'done',
    at: input.createdAt,
  };

  if (input.status === 'settled') {
    return [
      called,
      { key: 'live', label: 'Picks closed', detail: null, state: 'done', at: null },
      {
        key: 'settled',
        label: input.outcome ? OUTCOME_COPY[input.outcome] : 'Settled',
        detail: 'Rumble checked the match result and paid the group',
        state: 'done',
        at: input.settledAt,
      },
    ];
  }

  if (input.status === 'voided') {
    return [
      called,
      { key: 'live', label: 'Picks closed', detail: null, state: 'done', at: null },
      {
        key: 'settled',
        label: 'Call cancelled',
        detail: 'All SOL was returned',
        state: 'done',
        at: input.settledAt,
      },
    ];
  }

  const [liveLabel, defaultLiveDetail] = LIVE_STEP_COPY[input.status];
  const liveDetail = input.status === 'open'
    ? `Picks matched in ${(input.currency ?? 'sol').toUpperCase()}`
    : defaultLiveDetail;
  return [
    called,
    { key: 'live', label: liveLabel, detail: liveDetail, state: 'current', at: null },
    {
      key: 'settled',
      label: 'Result',
      detail: 'Rumble checks the match and posts the receipt',
      state: 'upcoming',
      at: null,
    },
  ];
}
