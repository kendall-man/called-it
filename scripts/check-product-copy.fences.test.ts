import assert from 'node:assert/strict';
import test from 'node:test';
import { scanFile } from './product-copy-contract.js';

test('ignores fenced runbook commands in guidance markdown', () => {
  // Given: a guidance doc quoting an operator command whose name trips a rule
  const runbook = 'Deterministic local loop:\n\n```bash\npnpm local:stack -- --webhook\n```\n';

  // When / Then: fenced lines are operator tooling, not consumer copy
  assert.deepEqual(scanFile('/repo/AGENTS.md', 'guidance', runbook), []);
});

test('still scans guidance prose outside code fences', () => {
  const prose = 'Build your stack before kickoff.\n';

  const violations = scanFile('/repo/AGENTS.md', 'guidance', prose);

  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.ruleId, 'language.stack');
});

test('keeps scanning fenced examples on non-guidance surfaces', () => {
  const instructions = 'Example reply:\n\n```\nTime to cash out.\n```\n';

  const violations = scanFile(
    '/repo/apps/concierge/agent/instructions/10-voice.md',
    'concierge',
    instructions,
  );

  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.ruleId, 'language.cashout');
});
