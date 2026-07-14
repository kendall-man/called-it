import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CASE_COUNT = 512;
const SCALE = 1_000n;
let state = 0xc011ed17;

function nextU32() {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state >>> 0;
}

function amount(limit) {
  return BigInt(nextU32() % limit);
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0n);
}

function settle(positions, outcome, ratioMilli) {
  const activeBack = sum(positions.filter(({ side }) => side === 'back').map(({ active }) => active));
  const activeDoubt = sum(positions.filter(({ side }) => side === 'doubt').map(({ active }) => active));
  const totalDeposits = sum(positions.map(({ active, pending, refundable }) => active + pending + refundable));

  if (outcome === 'void') {
    return {
      back: 0n,
      doubt: 0n,
      matchedBack: 0n,
      matchedDoubt: 0n,
      forfeitedPot: 0n,
      credits: positions.map(({ userKey, active, pending, refundable }) => ({
        userKey,
        refund: active + pending + refundable,
        payout: 0n,
      })),
      dust: 0n,
    };
  }

  const matchedBack = activeBack < (activeDoubt * SCALE) / ratioMilli
    ? activeBack
    : (activeDoubt * SCALE) / ratioMilli;
  const matchedDoubt = activeDoubt < (matchedBack * ratioMilli) / SCALE
    ? activeDoubt
    : (matchedBack * ratioMilli) / SCALE;
  const winningSide = outcome === 'claim_won' ? 'back' : 'doubt';
  const winningStakes = winningSide === 'back' ? activeBack : activeDoubt;
  const losingStakes = winningSide === 'back' ? activeDoubt : activeBack;
  const matchedLosing = winningSide === 'back' ? matchedDoubt : matchedBack;
  const forfeitedPot = sum(positions
    .filter(({ side }) => side !== winningSide)
    .map(({ active }) => losingStakes === 0n ? 0n : (active * matchedLosing) / losingStakes));
  const credits = positions.map(({ userKey, side, active, pending, refundable }) => {
    const baseRefund = pending + refundable;
    if (side === winningSide) {
      const winnings = winningStakes === 0n ? 0n : (active * forfeitedPot) / winningStakes;
      return { userKey, refund: baseRefund, payout: active + winnings };
    }
    const forfeit = losingStakes === 0n ? 0n : (active * matchedLosing) / losingStakes;
    return { userKey, refund: baseRefund + active - forfeit, payout: 0n };
  });
  const credited = sum(credits.map(({ refund, payout }) => refund + payout));
  if (credited > totalDeposits) throw new Error('generated entitlements exceed deposits');
  return {
    back: activeBack,
    doubt: activeDoubt,
    matchedBack,
    matchedDoubt,
    forfeitedPot,
    credits,
    dust: totalDeposits - credited,
  };
}

function decimal(value) {
  return value.toString(10);
}

const outcomes = ['claim_won', 'claim_lost', 'void'];
const cases = [];
for (let caseIndex = 0; caseIndex < CASE_COUNT; caseIndex += 1) {
  const ratioMilli = BigInt(1 + (nextU32() % 500_000));
  const outcome = outcomes[caseIndex % outcomes.length];
  const count = 1 + (nextU32() % 12);
  const positions = [];
  for (let index = 0; index < count; index += 1) {
    let active = amount(1_000_001);
    const pending = amount(100_001);
    const refundable = amount(100_001);
    if (active + pending + refundable === 0n) active = 1n;
    positions.push({
      userKey: index + 1,
      side: nextU32() % 2 === 0 ? 'back' : 'doubt',
      active,
      pending,
      refundable,
    });
  }
  const result = settle(positions, outcome, ratioMilli);
  cases.push({
    ratio_milli: decimal(ratioMilli),
    outcome,
    positions: positions.map(({ userKey, side, active, pending, refundable }) => ({
      user_key: userKey,
      side,
      active: decimal(active),
      pending: decimal(pending),
      refundable: decimal(refundable),
    })),
    expected: {
      back: decimal(result.back),
      doubt: decimal(result.doubt),
      matched_back: decimal(result.matchedBack),
      matched_doubt: decimal(result.matchedDoubt),
      forfeited_pot: decimal(result.forfeitedPot),
      credits: result.credits.map(({ userKey, refund, payout }) => ({
        user_key: userKey,
        refund: decimal(refund),
        payout: decimal(payout),
      })),
      dust: decimal(result.dust),
    },
  });
}

const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(here, '../vectors/payout-differential-v1.json');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify({ schema_version: 1, seed: '0xc011ed17', cases })}\n`);
