import type { PositionIndexedStatus } from './position-contract';

export type PositionStepId = 'submitted' | 'confirmed' | 'finalized' | 'active';
export type PositionStepStatus = 'done' | 'current' | 'upcoming';

export type PositionStep = {
  readonly id: PositionStepId;
  readonly label: string;
  readonly status: PositionStepStatus;
};

export type PositionProgressModel = {
  readonly steps: readonly PositionStep[];
  readonly fairPlayNote: string | null;
};

export const FAIR_PLAY_DELAY_NOTE = 'Fair-play check: your position activates shortly.';

const STEP_LABELS: Readonly<Record<PositionStepId, string>> = {
  submitted: 'Submitted',
  confirmed: 'Confirmed',
  finalized: 'Finalized',
  active: 'Active',
};

/**
 * Maps the /api/position/status fields onto the four-step signing journey.
 * `halted` marks a finalized position that will not activate (invalidated or
 * refundable); its last step stays "upcoming" and the status copy explains why.
 */
export function positionProgress(input: {
  readonly stage: 'confirming' | 'finalized';
  readonly commitment: PositionIndexedStatus['commitment'];
  readonly positionState: PositionIndexedStatus['positionState'];
}): PositionProgressModel {
  const finalized = input.stage === 'finalized';
  const confirmed = finalized || input.commitment !== null;
  const active = finalized &&
    (input.positionState === 'active' || input.positionState === 'claimed');
  const halted = finalized &&
    (input.positionState === 'invalidated' || input.positionState === 'refundable');
  const reached: Readonly<Record<PositionStepId, boolean>> = {
    submitted: true,
    confirmed,
    finalized,
    active,
  };
  const order: readonly PositionStepId[] = ['submitted', 'confirmed', 'finalized', 'active'];
  let currentAssigned = false;
  const steps = order.map((id): PositionStep => {
    if (reached[id]) return { id, label: STEP_LABELS[id], status: 'done' };
    if (!currentAssigned && !(id === 'active' && halted)) {
      currentAssigned = true;
      return { id, label: STEP_LABELS[id], status: 'current' };
    }
    return { id, label: STEP_LABELS[id], status: 'upcoming' };
  });
  return {
    steps,
    fairPlayNote: finalized && input.positionState === 'pending' ? FAIR_PLAY_DELAY_NOTE : null,
  };
}
