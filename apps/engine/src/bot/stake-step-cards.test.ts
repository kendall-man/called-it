import { describe, expect, it } from 'vitest';
import type { MarketSpec } from '@calledit/market-engine';
import {
  settlementPingText,
  signButtonLabel,
  signHandoffBody,
  sideLabelFor,
  stakeAmountLabel,
  stakeProgressBlock,
  STAKE_BACK_LABEL,
  valuePickBody,
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

describe('two-step stake copy', () => {
  it('names the side from the deterministic compiled labels, never LLM text', () => {
    expect(sideLabelFor(TEAM_SPEC, 'back')).toBe('France score 2+');
    expect(sideLabelFor(TEAM_SPEC, 'doubt')).toBe("They don't");
    // The binary fallback still resolves for label-less claim shapes.
    expect(sideLabelFor(TOTALS_SPEC, 'back')).toBe('It happens');
    expect(sideLabelFor(TOTALS_SPEC, 'doubt')).toBe('It does not');
  });

  it('back label carries no suffix', () => {
    expect(STAKE_BACK_LABEL).toBe('← Back');
  });

  it('progress block shows real completed steps and the one still to do', () => {
    const value = stakeProgressBlock('value', 'France score 2+');
    expect(value).toContain('✅ Priced');
    expect(value).toContain('✅ Side · France score 2+');
    expect(value).toContain('⬜ Stake');
    const sign = stakeProgressBlock('sign', 'France score 2+');
    expect(sign).toContain('✅ Stake');
  });

  it('value body names 0.01 the base stake and promises nothing moves until signing', () => {
    const body = valuePickBody('France score 2+');
    expect(body).toContain('0.01 is the base stake');
    expect(body).toContain('Nothing moves until you sign');
    // No pressure, no hype, no exclamation.
    expect(body).not.toContain('!');
  });

  it('sign body and button render the exact chosen amount, no exclamation', () => {
    const amount = stakeAmountLabel(50_000_000n, 'sol');
    expect(amount).toBe('0.05 SOL');
    const body = signHandoffBody('France score 2+', amount);
    expect(body).toContain('Review and sign 0.05 SOL for France score 2+');
    expect(body).not.toContain('!');
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
