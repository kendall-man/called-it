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

export const loadJourneyProfile = (profilePath, workspace, options = {}) => {
  if (!existsSync(profilePath)) fail(`profile does not exist: ${profilePath}`);
  const raw = object(JSON.parse(readFileSync(profilePath, 'utf8')), 'root');
  if (raw.version !== 1) fail('version must be 1');

  const runtimePath = localPath(workspace, raw.runtimeEnv, 'runtimeEnv');
  if (!existsSync(runtimePath)) fail(`runtimeEnv does not exist: ${runtimePath}`);
  const runtime = parseEnv(readFileSync(runtimePath, 'utf8'));

  const originConfig = object(raw.publicOrigin, 'publicOrigin');
  let origin = null;
  if (originConfig.source === 'url') {
    origin = url(originConfig.url, 'publicOrigin.url', ['https:']);
  } else if (originConfig.source === 'file') {
    const originPath = localPath(workspace, originConfig.path, 'publicOrigin.path');
    if (!existsSync(originPath)) {
      if (options.allowMissingPublicOrigin !== true) fail(`public origin file does not exist: ${originPath}`);
    } else {
      origin = url(readFileSync(originPath, 'utf8').trim(), 'public origin file', ['https:']);
    }
  } else {
    fail('publicOrigin.source must be "url" or "file"');
  }
  if (origin !== null) {
    origin.pathname = '/';
    origin.search = '';
    origin.hash = '';
  }
  const publicOrigin = origin?.toString().replace(/\/$/, '') ?? null;

  const services = object(raw.services, 'services');
  const engine = object(services.engine, 'services.engine');
  const web = object(services.web, 'services.web');
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
  const webhookUrl = publicOrigin === null ? null : new URL(webhookPath, `${publicOrigin}/`);
  if (webhookUrl !== null && webhookUrl.origin !== publicOrigin) {
    fail('telegram.webhookPath must remain on publicOrigin');
  }
  const resolvedRuntime = {
    ...runtime,
    ...environment,
    ...(publicOrigin === null ? {} : { WEB_BASE_URL: publicOrigin, WALLET_LINK_DOMAIN: origin?.hostname }),
    SOLANA_RPC_URL: rpcUrl,
    SOLANA_NETWORK: network,
    ESCROW_LOCAL_FORK_INDEXER: String(boolean(chain.localForkIndexer, 'chain.localForkIndexer')),
    CALLEDIT_REPLAY_SPEED: String(replaySpeed),
  };

  return Object.freeze({
    profilePath,
    runtimePath,
    publicOrigin,
    runtime: Object.freeze(resolvedRuntime),
    services: Object.freeze({
      engine: Object.freeze({ host: string(engine.host, 'services.engine.host'), port: integer(engine.port, 'services.engine.port') }),
      web: Object.freeze({ host: string(web.host, 'services.web.host'), port: integer(web.port, 'services.web.port') }),
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
