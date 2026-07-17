import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  defaultJourneyProfilePath,
  loadJourneyProfile,
  localWebPublicEnvironment,
} from './local-journey-profile.mjs';

test('one profile keeps the canonical web domain stable while the webhook uses a tunnel', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'calledit-profile-'));
  writeFileSync(join(workspace, 'runtime.env'), [
    'TELEGRAM_BOT_TOKEN=test-only',
    'TXORACLE_PROGRAM_ID=txoracle-public-id',
    'ESCROW_PROGRAM_ID=escrow-public-id',
    'ESCROW_GENESIS_HASH=devnet-public-genesis',
    'ESCROW_CANONICAL_USDC_MINT=devnet-public-usdc',
    '',
  ].join('\n'), { mode: 0o600 });
  writeFileSync(join(workspace, 'tunnel-url'), 'https://fresh.example.test\n', { mode: 0o600 });
  writeFileSync(join(workspace, 'journey.json'), JSON.stringify({
    version: 1,
    runtimeEnv: 'runtime.env',
    canonicalWebOrigin: 'https://canonical.example.test',
    services: {
      engine: { host: '127.0.0.1', port: 8790 },
      web: { host: '127.0.0.1', port: 3020, publicDataUrl: 'http://127.0.0.1:3002/' },
    },
    tunnel: { target: 'http://127.0.0.1:3020' },
    telegram: {
      webhookOrigin: { source: 'file', path: 'tunnel-url' },
      webhookPath: '/api/telegram-webhook',
      allowedUpdates: ['message', 'callback_query', 'my_chat_member'],
      dropPendingUpdates: true,
    },
    chain: {
      rpcUrl: 'http://127.0.0.1:8899',
      network: 'devnet',
      localForkIndexer: true,
    },
    replay: { speed: 8 },
    environment: { TELEGRAM_INGRESS: 'webhook' },
  }));

  const resolved = loadJourneyProfile(join(workspace, 'journey.json'), workspace);

  assert.equal(resolved.canonicalWebOrigin, 'https://canonical.example.test');
  assert.equal(resolved.webhookOrigin, 'https://fresh.example.test');
  assert.equal(resolved.services.web.publicDataUrl, 'http://127.0.0.1:3002');
  assert.equal(resolved.runtime.WEB_BASE_URL, 'https://canonical.example.test');
  assert.equal(resolved.runtime.WALLET_LINK_DOMAIN, 'canonical.example.test');
  assert.equal(resolved.runtime.SOLANA_RPC_URL, 'http://127.0.0.1:8899');
  assert.equal(resolved.runtime.ESCROW_LOCAL_FORK_INDEXER, 'true');
  assert.equal(resolved.runtime.CALLEDIT_REPLAY_SPEED, '8');
  assert.equal(resolved.runtime.TELEGRAM_INGRESS, 'webhook');
  assert.equal(resolved.webhookUrl, 'https://fresh.example.test/api/telegram-webhook');

  assert.deepEqual(localWebPublicEnvironment(resolved), {
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:3002',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'calledit-local-read-proxy',
    NEXT_PUBLIC_SOLANA_NETWORK: 'devnet',
    NEXT_PUBLIC_SOLANA_RPC_URL: 'http://127.0.0.1:8899',
    NEXT_PUBLIC_TXORACLE_PROGRAM_ID: 'txoracle-public-id',
    NEXT_PUBLIC_ESCROW_PROGRAM_ID: 'escrow-public-id',
    NEXT_PUBLIC_ESCROW_GENESIS_HASH: 'devnet-public-genesis',
    NEXT_PUBLIC_ESCROW_CANONICAL_USDC_MINT: 'devnet-public-usdc',
  });

  writeFileSync(join(workspace, 'tunnel-url'), 'https://rotated-hook.example.test\n', { mode: 0o600 });
  const rotated = loadJourneyProfile(join(workspace, 'journey.json'), workspace);
  assert.equal(rotated.webhookOrigin, 'https://rotated-hook.example.test');
  assert.equal(rotated.runtime.WEB_BASE_URL, 'https://canonical.example.test');
  assert.equal(rotated.runtime.WALLET_LINK_DOMAIN, 'canonical.example.test');
});

test('profile rejects credential-like settings', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'calledit-profile-'));
  writeFileSync(join(workspace, 'runtime.env'), '', { mode: 0o600 });
  const path = join(workspace, 'journey.json');
  for (const name of ['PRIVATE_SIGNING_KEY', 'GLM_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'AUTH_HEADER', 'SESSION_COOKIE']) {
    writeFileSync(path, JSON.stringify({
      version: 1,
      runtimeEnv: 'runtime.env',
      canonicalWebOrigin: 'https://safe.example.test',
      services: { engine: { host: '127.0.0.1', port: 8790 }, web: { host: '127.0.0.1', port: 3020, publicDataUrl: 'http://127.0.0.1:3002' } },
      tunnel: { target: 'http://127.0.0.1:3020' },
      telegram: { webhookOrigin: { source: 'url', url: 'https://hook.example.test' }, webhookPath: '/api/telegram-webhook', allowedUpdates: ['message'], dropPendingUpdates: false },
      chain: { rpcUrl: 'http://127.0.0.1:8899', network: 'devnet', localForkIndexer: true },
      replay: { speed: 8 },
      environment: { [name]: 'must-not-live-here' },
    }));

    assert.throws(() => loadJourneyProfile(path, workspace), /credential-like setting/i);
  }
});

test('profile rejects webhook paths that are not clean origin-relative paths', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'calledit-profile-'));
  writeFileSync(join(workspace, 'runtime.env'), '', { mode: 0o600 });
  const path = join(workspace, 'journey.json');
  for (const webhookPath of ['//attacker.example.test/capture', '/hook?mode=test', '/hook#fragment', '/hook\\capture']) {
    writeFileSync(path, JSON.stringify({
      version: 1,
      runtimeEnv: 'runtime.env',
      canonicalWebOrigin: 'https://safe.example.test',
      services: { engine: { host: '127.0.0.1', port: 8790 }, web: { host: '127.0.0.1', port: 3020, publicDataUrl: 'http://127.0.0.1:3002' } },
      tunnel: { target: 'http://127.0.0.1:3020' },
      telegram: { webhookOrigin: { source: 'url', url: 'https://hook.example.test' }, webhookPath, allowedUpdates: ['message'], dropPendingUpdates: false },
      chain: { rpcUrl: 'http://127.0.0.1:8899', network: 'devnet', localForkIndexer: true },
      replay: { speed: 8 },
    }));

    assert.throws(() => loadJourneyProfile(path, workspace), /webhookPath/i);
  }
});

test('profile allows only documented non-secret environment overrides', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'calledit-profile-'));
  writeFileSync(join(workspace, 'runtime.env'), '', { mode: 0o600 });
  const path = join(workspace, 'journey.json');
  writeFileSync(path, JSON.stringify({
    version: 1,
    runtimeEnv: 'runtime.env',
    canonicalWebOrigin: 'https://safe.example.test',
    services: { engine: { host: '127.0.0.1', port: 8790 }, web: { host: '127.0.0.1', port: 3020, publicDataUrl: 'http://127.0.0.1:3002' } },
    tunnel: { target: 'http://127.0.0.1:3020' },
    telegram: { webhookOrigin: { source: 'url', url: 'https://hook.example.test' }, webhookPath: '/api/telegram-webhook', allowedUpdates: ['message'], dropPendingUpdates: false },
    chain: { rpcUrl: 'http://127.0.0.1:8899', network: 'devnet', localForkIndexer: true },
    replay: { speed: 8 },
    environment: { LOG_LEVEL: 'debug' },
  }));

  assert.throws(() => loadJourneyProfile(path, workspace), /environment\.LOG_LEVEL/i);
});

test('relative profile selection resolves from the workspace', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'calledit-profile-'));
  const previous = process.env.CALLEDIT_LOCAL_PROFILE;
  process.env.CALLEDIT_LOCAL_PROFILE = 'profiles/local.json';

  try {
    assert.equal(defaultJourneyProfilePath(workspace), join(workspace, 'profiles/local.json'));
  } finally {
    if (previous === undefined) delete process.env.CALLEDIT_LOCAL_PROFILE;
    else process.env.CALLEDIT_LOCAL_PROFILE = previous;
  }
});

test('profile rejects an unsupported Solana network', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'calledit-profile-'));
  writeFileSync(join(workspace, 'runtime.env'), '', { mode: 0o600 });
  const path = join(workspace, 'journey.json');
  writeFileSync(path, JSON.stringify({
    version: 1,
    runtimeEnv: 'runtime.env',
    canonicalWebOrigin: 'https://safe.example.test',
    services: { engine: { host: '127.0.0.1', port: 8790 }, web: { host: '127.0.0.1', port: 3020, publicDataUrl: 'http://127.0.0.1:3002' } },
    tunnel: { target: 'http://127.0.0.1:3020' },
    telegram: { webhookOrigin: { source: 'url', url: 'https://hook.example.test' }, webhookPath: '/api/telegram-webhook', allowedUpdates: ['message'], dropPendingUpdates: false },
    chain: { rpcUrl: 'http://127.0.0.1:8899', network: 'testnet', localForkIndexer: true },
    replay: { speed: 8 },
  }));

  assert.throws(() => loadJourneyProfile(path, workspace), /chain\.network/i);
});
