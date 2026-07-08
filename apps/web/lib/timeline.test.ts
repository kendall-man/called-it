import { describe, expect, it } from 'vitest';
import { buildTimeline } from './timeline';

const CREATED_AT = '2026-07-10T18:00:00.000Z';
const SETTLED_AT = '2026-07-10T19:45:00.000Z';

describe('buildTimeline', () => {
  it('marks all steps done for a settled win', () => {
    const steps = buildTimeline({
      status: 'settled',
      createdAt: CREATED_AT,
      settledAt: SETTLED_AT,
      outcome: 'claim_won',
    });
    expect(steps.map((step) => step.state)).toEqual(['done', 'done', 'done']);
    expect(steps[2]?.label).toContain('called it');
    expect(steps[2]?.at).toBe(SETTLED_AT);
  });

  it('shows a current live step with settlement upcoming while open', () => {
    const steps = buildTimeline({
      status: 'open',
      createdAt: CREATED_AT,
      settledAt: null,
      outcome: null,
    });
    expect(steps.map((step) => step.state)).toEqual(['done', 'current', 'upcoming']);
    expect(steps[1]?.label).toBe('Calls open');
  });

  it('flags a VAR freeze as calls locked', () => {
    const steps = buildTimeline({
      status: 'frozen',
      createdAt: CREATED_AT,
      settledAt: null,
      outcome: null,
    });
    expect(steps[1]?.label).toBe('Calls locked');
    expect(steps[1]?.state).toBe('current');
  });

  it('ends a voided market with stakes returned', () => {
    const steps = buildTimeline({
      status: 'voided',
      createdAt: CREATED_AT,
      settledAt: null,
      outcome: null,
    });
    expect(steps[2]?.label).toContain('stakes returned');
    expect(steps[2]?.state).toBe('done');
  });
});
