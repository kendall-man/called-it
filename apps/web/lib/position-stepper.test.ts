import { describe, expect, it } from 'vitest';
import { FAIR_PLAY_DELAY_NOTE, positionProgress } from './position-stepper';

function statuses(model: ReturnType<typeof positionProgress>): readonly string[] {
  return model.steps.map((step) => `${step.id}:${step.status}`);
}

describe('position signing stepper', () => {
  it('shows submission done and confirmation running right after submit', () => {
    const model = positionProgress({ stage: 'confirming', commitment: null, positionState: null });
    expect(statuses(model)).toEqual([
      'submitted:done',
      'confirmed:current',
      'finalized:upcoming',
      'active:upcoming',
    ]);
    expect(model.fairPlayNote).toBeNull();
  });

  it('advances to finality once the transaction reaches confirmed commitment', () => {
    const model = positionProgress({
      stage: 'confirming',
      commitment: 'confirmed',
      positionState: null,
    });
    expect(statuses(model)).toEqual([
      'submitted:done',
      'confirmed:done',
      'finalized:current',
      'active:upcoming',
    ]);
  });

  it('marks activation as running while the finalized position is still projecting', () => {
    const model = positionProgress({
      stage: 'finalized',
      commitment: 'finalized',
      positionState: null,
    });
    expect(statuses(model)).toEqual([
      'submitted:done',
      'confirmed:done',
      'finalized:done',
      'active:current',
    ]);
    expect(model.fairPlayNote).toBeNull();
  });

  it('surfaces the fair-play delay while a finalized position is pending', () => {
    const model = positionProgress({
      stage: 'finalized',
      commitment: 'finalized',
      positionState: 'pending',
    });
    expect(statuses(model)).toEqual([
      'submitted:done',
      'confirmed:done',
      'finalized:done',
      'active:current',
    ]);
    expect(model.fairPlayNote).toBe(FAIR_PLAY_DELAY_NOTE);
    expect(model.fairPlayNote).not.toContain('—');
  });

  it('completes every step for active and claimed positions', () => {
    for (const positionState of ['active', 'claimed'] as const) {
      const model = positionProgress({ stage: 'finalized', commitment: 'finalized', positionState });
      expect(statuses(model)).toEqual([
        'submitted:done',
        'confirmed:done',
        'finalized:done',
        'active:done',
      ]);
      expect(model.fairPlayNote).toBeNull();
    }
  });

  it('halts before activation for invalidated or refundable positions without spinning', () => {
    for (const positionState of ['invalidated', 'refundable'] as const) {
      const model = positionProgress({ stage: 'finalized', commitment: 'finalized', positionState });
      expect(statuses(model)).toEqual([
        'submitted:done',
        'confirmed:done',
        'finalized:done',
        'active:upcoming',
      ]);
      expect(model.fairPlayNote).toBeNull();
    }
  });
});
