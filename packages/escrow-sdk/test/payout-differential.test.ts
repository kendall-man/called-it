import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  settlePositions,
  type EscrowMathPosition,
} from '../src/math-reference.js';
import type { SettlementOutcome } from '../src/domain.js';

interface DifferentialPosition {
  readonly user_key: number;
  readonly side: 'back' | 'doubt';
  readonly active: string;
  readonly pending: string;
  readonly refundable: string;
}

interface DifferentialCredit {
  readonly user_key: number;
  readonly refund: string;
  readonly payout: string;
}

interface DifferentialCase {
  readonly ratio_milli: string;
  readonly outcome: SettlementOutcome;
  readonly positions: readonly DifferentialPosition[];
  readonly expected: {
    readonly back: string;
    readonly doubt: string;
    readonly matched_back: string;
    readonly matched_doubt: string;
    readonly forfeited_pot: string;
    readonly credits: readonly DifferentialCredit[];
    readonly dust: string;
  };
}

interface DifferentialCorpus {
  readonly schema_version: number;
  readonly seed: string;
  readonly cases: readonly DifferentialCase[];
}

const corpus: DifferentialCorpus = JSON.parse(readFileSync(new URL(
  '../../../programs/calledit-escrow/vectors/payout-differential-v1.json',
  import.meta.url,
), 'utf8'));

function position(input: DifferentialPosition): EscrowMathPosition {
  return {
    id: String(input.user_key),
    owner: String(input.user_key),
    side: input.side,
    activeAmount: BigInt(input.active),
    pendingAmount: BigInt(input.pending),
    refundableAmount: BigInt(input.refundable),
  };
}

describe('Rust and TypeScript payout differential corpus', () => {
  it('loads the frozen 512-case schema V1 corpus', () => {
    expect(corpus.schema_version).toBe(1);
    expect(corpus.cases).toHaveLength(512);
  });

  it('matches every Rust settlement result', () => {
    for (const [index, vector] of corpus.cases.entries()) {
      const positions = vector.positions.map(position);
      const result = settlePositions(positions, vector.outcome, BigInt(vector.ratio_milli));
      const refunds = new Map(result.refunds.map((refund) => [refund.owner, refund.amount]));
      const credits = vector.expected.credits.map((credit) => ({
        userKey: credit.user_key,
        refund: refunds.get(String(credit.user_key)) ?? 0n,
        payout: result.payouts.get(String(credit.user_key)) ?? 0n,
      }));
      const winningSide = vector.outcome === 'claim_won' ? 'back' : 'doubt';
      const forfeitedPot = vector.outcome === 'void'
        ? 0n
        : positions
          .filter((item) => item.side !== winningSide)
          .reduce((sum, item) => {
            const total = item.activeAmount + item.pendingAmount + item.refundableAmount;
            return sum + total - (refunds.get(item.owner) ?? 0n);
          }, 0n);

      expect(result.pots, `case ${index} pots`).toEqual({
        backAmount: BigInt(vector.expected.back),
        doubtAmount: BigInt(vector.expected.doubt),
        matchedBack: BigInt(vector.expected.matched_back),
        matchedDoubt: BigInt(vector.expected.matched_doubt),
      });
      expect(credits, `case ${index} credits`).toEqual(vector.expected.credits.map((credit) => ({
        userKey: credit.user_key,
        refund: BigInt(credit.refund),
        payout: BigInt(credit.payout),
      })));
      expect(forfeitedPot, `case ${index} forfeited pot`).toBe(BigInt(vector.expected.forfeited_pot));
      expect(result.dust, `case ${index} dust`).toBe(BigInt(vector.expected.dust));
    }
  });
});
