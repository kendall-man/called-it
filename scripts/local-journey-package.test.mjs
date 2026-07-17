import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('package exposes the local journey compatibility commands', () => {
  assert.equal(manifest.scripts['local:preflight'], 'node scripts/local-journey.mjs preflight');
  assert.equal(manifest.scripts['local:tunnel'], 'node scripts/local-journey.mjs tunnel');
  assert.equal(manifest.scripts['local:webhook'], 'node scripts/local-journey.mjs webhook');
  assert.equal(
    manifest.scripts['production:webhook'],
    'railway run --service engine -- node scripts/production-telegram-webhook.mjs',
  );
});

test('verification includes the focused local journey tests', () => {
  assert.match(manifest.scripts['test:local-journey'], /local-journey-profile\.test\.mjs/);
  assert.match(manifest.scripts['test:local-journey'], /local-stack-supervisor\.test\.mjs/);
  assert.match(
    manifest.scripts['test:local-journey'],
    /production-telegram-webhook\.test\.mjs/,
  );
  assert.match(manifest.scripts.verify, /test:local-journey/);
});
