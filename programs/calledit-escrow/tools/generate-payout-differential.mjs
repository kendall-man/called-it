import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MIN_CASE_COUNT = 4_096;
export const DEFAULT_CASE_COUNT = 4_096;
export const DEFAULT_SEED = 'calledit-payout-differential-v2-2026-07-15';
const SCALE = 1_000n;

function fail(message) {
  throw new Error(`payout differential generator: ${message}`);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function caseSeed(seed, caseIndex) {
  return sha256(`${seed}\0${caseIndex}`);
}

function randomFor(seedHex) {
  const bytes = Buffer.from(seedHex, 'hex');
  let a = bytes.readUInt32LE(0);
  let b = bytes.readUInt32LE(4);
  let c = bytes.readUInt32LE(8);
  let d = bytes.readUInt32LE(12);
  return () => {
    const result = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = ((c << 21) | (c >>> 11)) + result | 0;
    return result >>> 0;
  };
}

function amount(nextU32, limit) {
  if (limit <= 0n) fail('amount limit must be positive');
  const random64 = (BigInt(nextU32()) << 32n) | BigInt(nextU32());
  return random64 % limit;
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
  if (credited > totalDeposits) fail('generated entitlements exceed deposits');
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

function sideFor(mode, index, nextU32) {
  if (mode === 0) return 'back';
  if (mode === 1) return 'doubt';
  if (mode === 2) return index % 2 === 0 ? 'back' : 'doubt';
  return nextU32() % 2 === 0 ? 'back' : 'doubt';
}

function generateCase(seed, caseIndex) {
  const derivedSeed = caseSeed(seed, caseIndex);
  const nextU32 = randomFor(derivedSeed);
  const outcomes = ['claim_won', 'claim_lost', 'void'];
  const amountLimits = [17n, 1_000_001n, 1_000_000_001n, 1_000_000_000_001n];
  const amountLimit = amountLimits[nextU32() % amountLimits.length];
  const ratioMilli = 1n + amount(nextU32, 1_000_000n);
  const outcome = outcomes[(nextU32() + caseIndex) % outcomes.length];
  const count = 1 + (nextU32() % 24);
  const sideMode = nextU32() % 8;
  const positions = [];
  for (let index = 0; index < count; index += 1) {
    let active = amount(nextU32, amountLimit);
    const pending = amount(nextU32, amountLimit);
    const refundable = amount(nextU32, amountLimit);
    if (active + pending + refundable === 0n) active = 1n;
    positions.push({
      userKey: index + 1,
      side: sideFor(sideMode, index, nextU32),
      active,
      pending,
      refundable,
    });
  }
  const result = settle(positions, outcome, ratioMilli);
  return {
    case_seed: derivedSeed,
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
  };
}

export function generateCorpus({ seed = DEFAULT_SEED, caseCount = DEFAULT_CASE_COUNT } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(seed)) fail('seed must be a stable public identifier');
  if (!Number.isSafeInteger(caseCount) || caseCount < MIN_CASE_COUNT) {
    fail(`case count must be a safe integer of at least ${MIN_CASE_COUNT}`);
  }
  const cases = Array.from({ length: caseCount }, (_, caseIndex) => generateCase(seed, caseIndex));
  if (new Set(cases.map((entry) => entry.case_seed)).size !== caseCount) fail('derived case seeds are not unique');
  return { schema_version: 2, seed, case_count: caseCount, cases };
}

function parseArgs(args) {
  const here = dirname(fileURLToPath(import.meta.url));
  const options = {
    seed: DEFAULT_SEED,
    caseCount: DEFAULT_CASE_COUNT,
    output: resolve(here, '../vectors/payout-differential-v1.json'),
  };
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (value === undefined) fail(`${key ?? 'option'} requires a value`);
    if (key === '--seed') options.seed = value;
    else if (key === '--case-count') options.caseCount = Number(value);
    else if (key === '--out') options.output = resolve(value);
    else fail('unknown option');
  }
  return options;
}

export function writeCorpus(options = {}) {
  const corpus = generateCorpus(options);
  const here = dirname(fileURLToPath(import.meta.url));
  const output = resolve(options.output ?? resolve(here, '../vectors/payout-differential-v1.json'));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(corpus)}\n`, { flag: 'w' });
  return { output, seed: corpus.seed, caseCount: corpus.case_count };
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  const options = parseArgs(process.argv.slice(2));
  const result = writeCorpus({ seed: options.seed, caseCount: options.caseCount, output: options.output });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
