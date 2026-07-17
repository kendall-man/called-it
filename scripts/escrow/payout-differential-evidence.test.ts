import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PAYOUT_DIFFERENTIAL_MIN_CASES,
  createPayoutDifferentialEvidenceReceipt,
  parsePayoutDifferentialEvidenceReceipt,
} from './payout-differential-evidence.js';
import { sha256, stableJson } from './util.js';

function corpusBytes(): Buffer {
  return Buffer.from(JSON.stringify({
    schema_version: 2,
    seed: 'independent-seed-v2',
    case_count: PAYOUT_DIFFERENTIAL_MIN_CASES,
    cases: Array.from({ length: PAYOUT_DIFFERENTIAL_MIN_CASES }, () => ({})),
  }));
}

function language(language: 'rust' | 'typescript', corpus: Buffer, resultSha256 = 'a'.repeat(64)): unknown {
  return {
    schemaVersion: 1,
    language,
    seed: 'independent-seed-v2',
    caseCount: PAYOUT_DIFFERENTIAL_MIN_CASES,
    corpusSha256: sha256(corpus),
    resultSha256,
  };
}

test('creates a deterministic content-addressed release-bound receipt', () => {
  const corpus = corpusBytes();
  const input = {
    sourceCommit: 'b'.repeat(40),
    corpusBytes: corpus,
    rustResult: language('rust', corpus),
    typescriptResult: language('typescript', corpus),
  };
  const first = createPayoutDifferentialEvidenceReceipt(input);
  const second = createPayoutDifferentialEvidenceReceipt(input);

  assert.deepEqual(first, second);
  assert.equal(first.caseCount, PAYOUT_DIFFERENTIAL_MIN_CASES);
  assert.equal(first.rustResultSha256, first.typescriptResultSha256);
  assert.deepEqual(parsePayoutDifferentialEvidenceReceipt(first), first);
});

test('rejects language result disagreement and corpus drift', () => {
  const corpus = corpusBytes();
  assert.throws(() => createPayoutDifferentialEvidenceReceipt({
    sourceCommit: 'b'.repeat(40),
    corpusBytes: corpus,
    rustResult: language('rust', corpus),
    typescriptResult: language('typescript', corpus, 'c'.repeat(64)),
  }), /result digests differ/);

  const wrongCorpus = { ...(language('rust', corpus) as Record<string, unknown>), corpusSha256: 'd'.repeat(64) };
  assert.throws(() => createPayoutDifferentialEvidenceReceipt({
    sourceCommit: 'b'.repeat(40),
    corpusBytes: corpus,
    rustResult: wrongCorpus,
    typescriptResult: language('typescript', corpus),
  }), /corpus digest mismatch/);
});

test('rejects receipt field tampering through its content address', () => {
  const corpus = corpusBytes();
  const receipt = createPayoutDifferentialEvidenceReceipt({
    sourceCommit: 'b'.repeat(40),
    corpusBytes: corpus,
    rustResult: language('rust', corpus),
    typescriptResult: language('typescript', corpus),
  });
  const tampered = { ...receipt, seed: 'tampered-seed' };
  assert.throws(() => parsePayoutDifferentialEvidenceReceipt(tampered), /content address mismatch/);
  assert.notEqual(sha256(stableJson(tampered)), receipt.receiptSha256);
});
