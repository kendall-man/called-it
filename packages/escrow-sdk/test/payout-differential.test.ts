import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
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
  readonly case_seed: string;
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
  readonly case_count: number;
  readonly cases: readonly DifferentialCase[];
}

const corpusUrl = new URL(
  '../../../programs/calledit-escrow/vectors/payout-differential-v1.json',
  import.meta.url,
);
const corpusBytes = readFileSync(corpusUrl);
const corpus: DifferentialCorpus = JSON.parse(corpusBytes.toString('utf8'));

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function caseSeed(seed: string, caseIndex: number): string {
  return sha256(`${seed}\0${caseIndex}`);
}

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
  it('loads at least 4,096 independently seeded schema V2 cases', () => {
    expect(corpus.schema_version).toBe(2);
    expect(corpus.case_count).toBe(corpus.cases.length);
    expect(corpus.cases.length).toBeGreaterThanOrEqual(4_096);
    const seeds = corpus.cases.map((vector, index) => {
      expect(vector.case_seed, `case ${index} seed`).toBe(caseSeed(corpus.seed, index));
      return vector.case_seed;
    });
    expect(new Set(seeds).size).toBe(corpus.case_count);
  });

  it('matches every Rust settlement result', () => {
    let canonicalResults = '';
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
      expect(result.totalEntitlement + result.dust, `case ${index} conservation`).toBe(result.totalDeposits);
      canonicalResults += [
        index,
        result.pots.backAmount,
        result.pots.doubtAmount,
        result.pots.matchedBack,
        result.pots.matchedDoubt,
        forfeitedPot,
        result.dust,
      ].join('|');
      canonicalResults += '|';
      canonicalResults += credits.map((credit) => `${credit.userKey}:${credit.refund}:${credit.payout},`).join('');
      canonicalResults += '\n';
    }

    const resultSha256 = sha256(canonicalResults);
    const outputPath = process.env['PAYOUT_DIFFERENTIAL_TYPESCRIPT_RESULT_PATH'];
    if (outputPath !== undefined) {
      writeFileSync(outputPath, `${JSON.stringify({
        schemaVersion: 1,
        language: 'typescript',
        seed: corpus.seed,
        caseCount: corpus.case_count,
        corpusSha256: sha256(corpusBytes),
        resultSha256,
      })}\n`, { flag: 'wx' });
    }
  });
});
