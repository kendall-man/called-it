import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { defaultJourneyProfilePath, loadJourneyProfile } from './local-journey-profile.mjs';

const workspace = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
const state = resolve(workspace, '.calledit-local');
const profilePath = defaultJourneyProfilePath(workspace);
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const area = args[0] ?? 'profile';
const action = args[1] ?? 'status';
const pidPath = resolve(state, 'tunnel.pid');
const logPath = resolve(state, 'tunnel.log');
const urlPath = resolve(state, 'web-tunnel-url');

const alive = (pid) => {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
};
const savedPid = () => existsSync(pidPath) ? Number(readFileSync(pidPath, 'utf8').trim()) : null;
const safeTunnelPid = (pid) => {
  if (!pid || !alive(pid)) return false;
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).includes('cloudflared tunnel');
  } catch {
    return false;
  }
};
const commandExists = (name) => {
  try { execFileSync('sh', ['-lc', `command -v ${name}`], { stdio: 'ignore' }); return true; }
  catch { return false; }
};
const telegramCall = async (runtime, method, body) => {
  const token = runtime.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('runtimeEnv is missing TELEGRAM_BOT_TOKEN');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json();
  if (!result.ok) throw new Error(`Telegram ${method} failed: ${result.description ?? response.status}`);
  return result.result;
};

if (area === 'profile') {
  const profile = loadJourneyProfile(profilePath, workspace, {
    allowMissingWebhookOrigin: true,
    allowMissingWebAppOrigin: true,
  });
  console.log(JSON.stringify({
    ok: true,
    profile: profile.profilePath,
    runtimeEnv: profile.runtimePath,
    canonicalWebOrigin: profile.canonicalWebOrigin,
    runtimeWebOrigin: profile.runtimeWebOrigin,
    webAppUsesTunnel: profile.runtimeWebOrigin === profile.webhookOrigin,
    webhookOriginReady: profile.webhookOrigin !== null,
    services: profile.services,
    tunnel: profile.tunnel,
    telegram: profile.telegram,
    chain: profile.chain,
    replay: profile.replay,
  }, null, 2));
} else if (area === 'preflight') {
  const profile = loadJourneyProfile(profilePath, workspace, {
    allowMissingWebhookOrigin: true,
    allowMissingWebAppOrigin: true,
  });
  const required = ['TELEGRAM_BOT_TOKEN', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'TELEGRAM_WEBHOOK_SECRET_TOKEN'];
  const missing = required.filter((name) => !profile.runtime[name]);
  const mode = (statSync(profile.runtimePath).mode & 0o777).toString(8).padStart(3, '0');
  const report = {
    ok: missing.length === 0 && mode === '600' && commandExists('node') && commandExists('npx') && commandExists('cloudflared'),
    profileReady: true,
    canonicalWebOrigin: profile.canonicalWebOrigin,
    runtimeWebOrigin: profile.runtimeWebOrigin,
    webAppUsesTunnel: profile.runtimeWebOrigin === profile.webhookOrigin,
    webhookOriginReady: profile.webhookOrigin !== null,
    runtimeEnv: { mode, configuredKeys: Object.values(profile.runtime).filter(Boolean).length, missing },
    commands: { node: commandExists('node'), npx: commandExists('npx'), cloudflared: commandExists('cloudflared') },
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} else if (area === 'tunnel') {
  const profile = loadJourneyProfile(profilePath, workspace, {
    allowMissingWebhookOrigin: true,
    allowMissingWebAppOrigin: true,
  });
  if (action === 'status') {
    const pid = savedPid();
    console.log(JSON.stringify({ running: safeTunnelPid(pid), pid, webhookOriginReady: existsSync(urlPath), target: profile.tunnel.target }, null, 2));
    if (!safeTunnelPid(pid)) process.exitCode = 1;
  } else if (action === 'stop') {
    const pid = savedPid();
    if (safeTunnelPid(pid)) process.kill(pid, 'SIGTERM');
    console.log(JSON.stringify({ stopped: Boolean(pid), pid }, null, 2));
  } else if (action === 'start') {
    mkdirSync(dirname(urlPath), { recursive: true, mode: 0o700 });
    const existing = savedPid();
    if (safeTunnelPid(existing)) throw new Error(`Tunnel already running with PID ${existing}`);
    const health = await fetch(profile.tunnel.target, { method: 'HEAD', signal: AbortSignal.timeout(3_000) });
    if (!health.ok) throw new Error(`Tunnel target returned HTTP ${health.status}`);
    const fd = openSync(logPath, 'w', 0o600);
    const child = spawn('cloudflared', ['tunnel', '--url', profile.tunnel.target, '--no-autoupdate'], {
      cwd: workspace, detached: true, stdio: ['ignore', fd, fd],
    });
    closeSync(fd);
    child.unref();
    writeFileSync(pidPath, `${child.pid}\n`, { mode: 0o600 });
    let webhookOrigin = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await delay(250);
      const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
      webhookOrigin = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)?.[0] ?? null;
      if (webhookOrigin !== null) break;
      if (!alive(child.pid)) throw new Error(`cloudflared exited; inspect ${logPath}`);
    }
    if (webhookOrigin === null) throw new Error(`Tunnel URL deadline exceeded; inspect ${logPath}`);
    writeFileSync(urlPath, `${webhookOrigin}\n`, { mode: 0o600 });
    const resolved = loadJourneyProfile(profilePath, workspace);
    console.log(JSON.stringify({
      running: true,
      pid: child.pid,
      canonicalWebOrigin: resolved.canonicalWebOrigin,
      runtimeWebOrigin: resolved.runtimeWebOrigin,
      webhookOrigin: resolved.webhookOrigin,
      target: resolved.tunnel.target,
      restartStack: resolved.runtimeWebOrigin !== resolved.canonicalWebOrigin,
    }, null, 2));
  } else {
    throw new Error('Usage: pnpm local:journey tunnel <start|status|stop>');
  }
} else if (area === 'webhook') {
  const profile = loadJourneyProfile(profilePath, workspace);
  if (action === 'status') {
    const info = await telegramCall(profile.runtime, 'getWebhookInfo');
    let endpoint = null;
    try { const parsed = new URL(info.url); endpoint = `${parsed.host}${parsed.pathname}`; } catch { endpoint = null; }
    console.log(JSON.stringify({ endpoint, pending: info.pending_update_count ?? 0, lastError: info.last_error_message ?? null }, null, 2));
  } else if (action === 'set') {
    const secret = profile.runtime.TELEGRAM_WEBHOOK_SECRET_TOKEN;
    if (!secret) throw new Error('runtimeEnv is missing TELEGRAM_WEBHOOK_SECRET_TOKEN');
    await telegramCall(profile.runtime, 'setWebhook', {
      url: profile.webhookUrl,
      secret_token: secret,
      drop_pending_updates: profile.telegram.dropPendingUpdates,
      allowed_updates: profile.telegram.allowedUpdates,
    });
    const endpoint = new URL(profile.webhookUrl);
    console.log(JSON.stringify({ configured: true, endpoint: `${endpoint.host}${endpoint.pathname}` }, null, 2));
  } else if (action === 'clear') {
    await telegramCall(profile.runtime, 'deleteWebhook', { drop_pending_updates: profile.telegram.dropPendingUpdates });
    console.log(JSON.stringify({ cleared: true }, null, 2));
  } else {
    throw new Error('Usage: pnpm local:journey webhook <set|status|clear>');
  }
} else {
  throw new Error('Usage: pnpm local:journey <profile|preflight|tunnel|webhook> [action]');
}
