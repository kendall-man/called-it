import { describe, expect, it } from 'vitest';
import type { MarketSpec } from '@calledit/market-engine';
import {
  confirmButtonLabel,
  settlementPingText,
  signButtonLabel,
  sideLabelFor,
  stakeAmountLabel,
  STAKE_BACK_LABEL,
  STAKE_STEP_DOWN_LABEL,
  STAKE_STEP_UP_LABEL,
  stepperNote,
} from './stake-step-cards.js';

const TEAM_SPEC: MarketSpec = {
  claimType: 'team_scores_n',
  fixtureId: 1234,
  entityRef: { kind: 'team', participant: 1, name: 'France' },
  comparator: 'gte',
  threshold: 2,
  period: 'FT_90',
  trustTier: 'chain_proven',
};

const TOTALS_SPEC: MarketSpec = {
  claimType: 'totals_ou',
  fixtureId: 1234,
  entityRef: { kind: 'team', participant: 1, name: 'France' },
  comparator: 'gte',
  threshold: 3,
  period: 'FT_90',
  trustTier: 'oracle_resolved',
};

describe('n-step stepper copy', () => {
  it('names the side from the deterministic compiled labels, never LLM text', () => {
    expect(sideLabelFor(TEAM_SPEC, 'back')).toBe('France score 2+');
    expect(sideLabelFor(TEAM_SPEC, 'doubt')).toBe("They don't");
    // The binary fallback still resolves for label-less claim shapes.
    expect(sideLabelFor(TOTALS_SPEC, 'back')).toBe('It happens');
    expect(sideLabelFor(TOTALS_SPEC, 'doubt')).toBe('It does not');
  });

  it('back label carries no suffix; step glyphs are minus and plus', () => {
    expect(STAKE_BACK_LABEL).toBe('← Back');
    expect(STAKE_STEP_DOWN_LABEL).toBe('−');
    expect(STAKE_STEP_UP_LABEL).toBe('+');
  });

  it('stepper note stays small: current stake + the base-stake anchor', () => {
    const note = stepperNote('France score 2+', '0.02 SOL');
    expect(note).toContain('France score 2+');
    expect(note).toContain('0.02 SOL');
    expect(note).toContain('0.01 is the base stake');
    expect(note).toContain('Nothing moves until you sign');
    // Two short lines, no pressure, no hype, no exclamation.
    expect(note.split('\n')).toHaveLength(2);
    expect(note).not.toContain('!');
  });

  it('confirm and sign actions render the exact shown amount, no exclamation', () => {
    const amount = stakeAmountLabel(50_000_000n, 'sol');
    expect(amount).toBe('0.05 SOL');
    expect(confirmButtonLabel(amount)).toBe('Confirm 0.05 SOL');
    expect(confirmButtonLabel(amount)).not.toContain('!');
    expect(signButtonLabel(amount, 'France score 2+')).toBe(
      'Review & sign 0.05 SOL for France score 2+',
    );
  });

  it('settlement ping is compact, hype-free, and links the board/receipt', () => {
    const url = 'https://called-it.example/r/abc';
    expect(settlementPingText('claim_won', url)).toBe(`Called it — settled. Board and receipt: ${url}`);
    expect(settlementPingText('claim_lost', url)).toContain('the call goes down');
    expect(settlementPingText('void', url)).toContain('positions returned');
    // No re-stake prompt, no exclamation anywhere in the money notification.
    for (const outcome of ['claim_won', 'claim_lost', 'void'] as const) {
      const text = settlementPingText(outcome, url);
      expect(text).not.toContain('!');
      expect(text.toLowerCase()).not.toContain('again');
    }
  });
});
