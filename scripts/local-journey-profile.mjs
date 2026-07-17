import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { parseEnv } from 'node:util';

const credentialName = /(?:secret|token|password|mnemonic|seed|key|auth|cookie|credential|bearer|jwt|signer)/i;
const environmentNames = new Set(['TELEGRAM_INGRESS']);
const solanaNetworks = new Set(['devnet', 'mainnet-beta']);
const telegramUpdateNames = new Set(['message', 'callback_query', 'my_chat_member']);

const fail = (message) => {
  throw new TypeError(`Invalid local journey profile: ${message}`);
};

const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
};

const string = (value, label) => {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} must be a non-empty string`);
  return value;
};

const integer = (value, label, { min = 1, max = 65_535 } = {}) => {
  if (!Number.isInteger(value) || value < min || value > max) fail(`${label} must be an integer from ${min} to ${max}`);
  return value;
};

const boolean = (value, label) => {
  if (typeof value !== 'boolean') fail(`${label} must be a boolean`);
  return value;
};

const url = (value, label, protocols) => {
  let parsed;
  try { parsed = new URL(string(value, label)); }
  catch { fail(`${label} must be a valid URL`); }
  if (!protocols.includes(parsed.protocol)) fail(`${label} must use ${protocols.join(' or ')}`);
  return parsed;
};

const localPath = (workspace, value, label) => {
  const path = string(value, label);
  return isAbsolute(path) ? path : resolve(workspace, path);
};

export const defaultJourneyProfilePath = (workspace) => {
  const configured = process.env.CALLEDIT_LOCAL_PROFILE;
  return configured === undefined
    ? resolve(workspace, '.calledit-local/journey.json')
    : localPath(workspace, configured, 'CALLEDIT_LOCAL_PROFILE');
};

export const localWebPublicEnvironment = (profile) => Object.freeze({
  NEXT_PUBLIC_SUPABASE_URL: profile.services.web.publicDataUrl,
  // The local compatibility proxy intentionally ignores auth headers. This is
  // a non-secret marker, never a hosted Supabase credential.
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'calledit-local-read-proxy',
  NEXT_PUBLIC_SOLANA_NETWORK: profile.chain.network,
  NEXT_PUBLIC_SOLANA_RPC_URL: profile.chain.rpcUrl,
  NEXT_PUBLIC_TXORACLE_PROGRAM_ID: profile.runtime.TXORACLE_PROGRAM_ID,
  NEXT_PUBLIC_ESCROW_PROGRAM_ID: profile.runtime.ESCROW_PROGRAM_ID,
  NEXT_PUBLIC_ESCROW_GENESIS_HASH: profile.runtime.ESCROW_GENESIS_HASH,
  ...(profile.runtime.ESCROW_CANONICAL_USDC_MINT === undefined
    ? {}
    : { NEXT_PUBLIC_ESCROW_CANONICAL_USDC_MINT: profile.runtime.ESCROW_CANONICAL_USDC_MINT }),
});

export const loadJourneyProfile = (profilePath, workspace, options = {}) => {
  if (!existsSync(profilePath)) fail(`profile does not exist: ${profilePath}`);
  const raw = object(JSON.parse(readFileSync(profilePath, 'utf8')), 'root');
  if (raw.version !== 1) fail('version must be 1');

  const runtimePath = localPath(workspace, raw.runtimeEnv, 'runtimeEnv');
  if (!existsSync(runtimePath)) fail(`runtimeEnv does not exist: ${runtimePath}`);
  const runtime = parseEnv(readFileSync(runtimePath, 'utf8'));

  const canonicalOrigin = url(raw.canonicalWebOrigin, 'canonicalWebOrigin', ['https:']);
  canonicalOrigin.pathname = '/';
  canonicalOrigin.search = '';
  canonicalOrigin.hash = '';
  const canonicalWebOrigin = canonicalOrigin.toString().replace(/\/$/, '');

  const services = object(raw.services, 'services');
  const engine = object(services.engine, 'services.engine');
  const web = object(services.web, 'services.web');
  const publicDataUrl = url(web.publicDataUrl, 'services.web.publicDataUrl', ['http:', 'https:'])
    .toString()
    .replace(/\/$/, '');
  const tunnel = object(raw.tunnel, 'tunnel');
  const telegram = object(raw.telegram, 'telegram');
  const chain = object(raw.chain, 'chain');
  const replay = object(raw.replay, 'replay');

  const webhookPath = string(telegram.webhookPath, 'telegram.webhookPath');
  if (!webhookPath.startsWith('/') || webhookPath.startsWith('//') || /[\\?#]/.test(webhookPath)) {
    fail('telegram.webhookPath must be an origin-relative path without query, hash, or backslash');
  }
  if (!Array.isArray(telegram.allowedUpdates) || telegram.allowedUpdates.length === 0) {
    fail('telegram.allowedUpdates must be a non-empty array');
  }
  for (const update of telegram.allowedUpdates) {
    if (!telegramUpdateNames.has(update)) fail(`unsupported Telegram update: ${String(update)}`);
  }

  const webhookOriginConfig = object(telegram.webhookOrigin, 'telegram.webhookOrigin');
  let webhookOrigin = null;
  if (webhookOriginConfig.source === 'url') {
    webhookOrigin = url(webhookOriginConfig.url, 'telegram.webhookOrigin.url', ['https:']);
  } else if (webhookOriginConfig.source === 'file') {
    const webhookOriginPath = localPath(workspace, webhookOriginConfig.path, 'telegram.webhookOrigin.path');
    if (!existsSync(webhookOriginPath)) {
      if (options.allowMissingWebhookOrigin !== true) {
        fail(`telegram webhook origin file does not exist: ${webhookOriginPath}`);
      }
    } else {
      webhookOrigin = url(readFileSync(webhookOriginPath, 'utf8').trim(), 'telegram webhook origin file', ['https:']);
    }
  } else {
    fail('telegram.webhookOrigin.source must be "url" or "file"');
  }
  if (webhookOrigin !== null) {
    webhookOrigin.pathname = '/';
    webhookOrigin.search = '';
    webhookOrigin.hash = '';
  }
  const resolvedWebhookOrigin = webhookOrigin?.toString().replace(/\/$/, '') ?? null;

  const environment = raw.environment === undefined ? {} : object(raw.environment, 'environment');
  for (const [name, value] of Object.entries(environment)) {
    if (credentialName.test(name)) fail(`credential-like setting ${name} belongs in runtimeEnv`);
    if (!environmentNames.has(name)) fail(`environment.${name} is not an allowed override`);
    if (typeof value !== 'string') fail(`environment.${name} must be a string`);
  }

  const rpcUrl = url(chain.rpcUrl, 'chain.rpcUrl', ['http:', 'https:']).toString().replace(/\/$/, '');
  const network = string(chain.network, 'chain.network');
  if (!solanaNetworks.has(network)) fail('chain.network must be "devnet" or "mainnet-beta"');
  const replaySpeed = integer(replay.speed, 'replay.speed', { min: 1, max: 1_000 });
  const webhookUrl = resolvedWebhookOrigin === null
    ? null
    : new URL(webhookPath, `${resolvedWebhookOrigin}/`);
  if (webhookUrl !== null && webhookUrl.origin !== resolvedWebhookOrigin) {
    fail('telegram.webhookPath must remain on telegram.webhookOrigin');
  }
  const resolvedRuntime = {
    ...runtime,
    ...environment,
    WEB_BASE_URL: canonicalWebOrigin,
    WALLET_LINK_DOMAIN: canonicalOrigin.hostname,
    SOLANA_RPC_URL: rpcUrl,
    SOLANA_NETWORK: network,
    ESCROW_LOCAL_FORK_INDEXER: String(boolean(chain.localForkIndexer, 'chain.localForkIndexer')),
    CALLEDIT_REPLAY_SPEED: String(replaySpeed),
  };

  return Object.freeze({
    profilePath,
    runtimePath,
    canonicalWebOrigin,
    webhookOrigin: resolvedWebhookOrigin,
    runtime: Object.freeze(resolvedRuntime),
    services: Object.freeze({
      engine: Object.freeze({ host: string(engine.host, 'services.engine.host'), port: integer(engine.port, 'services.engine.port') }),
      web: Object.freeze({
        host: string(web.host, 'services.web.host'),
        port: integer(web.port, 'services.web.port'),
        publicDataUrl,
      }),
    }),
    tunnel: Object.freeze({ target: url(tunnel.target, 'tunnel.target', ['http:', 'https:']).toString().replace(/\/$/, '') }),
    telegram: Object.freeze({
      webhookPath,
      allowedUpdates: Object.freeze([...telegram.allowedUpdates]),
      dropPendingUpdates: boolean(telegram.dropPendingUpdates, 'telegram.dropPendingUpdates'),
    }),
    chain: Object.freeze({ rpcUrl, network: resolvedRuntime.SOLANA_NETWORK, localForkIndexer: chain.localForkIndexer }),
    replay: Object.freeze({ speed: replaySpeed }),
    webhookUrl: webhookUrl?.toString() ?? null,
  });
};
