import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { parseEnv } from 'node:util';

const root = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '');
const envPath = process.env.CALLEDIT_RUNTIME_ENV ?? `${root}/.calledit-local/runtime.env`;
const command = (name) => {
  try { return execFileSync('sh', ['-lc', `command -v ${name}`], { encoding: 'utf8' }).trim() || null; }
  catch { return null; }
};
const source = (path) => existsSync(path) ? readFileSync(path, 'utf8') : '';
const engineServer = source(`${root}/apps/engine/src/api/server.ts`);
const webProxy = existsSync(`${root}/apps/web/app/api/telegram-webhook/route.ts`);
const directWebhook = engineServer.includes("path === '/api/telegram-webhook'");
const concierge = existsSync(`${root}/apps/concierge/agent/channels/telegram.ts`);
const architecture = webProxy ? 'web-proxy' : directWebhook ? 'engine-direct' : concierge ? 'concierge-forwarder' : 'unsupported';
const directTunnelSupported = webProxy || directWebhook;
const runtime = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {};
const required = ['TELEGRAM_BOT_TOKEN', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
if (architecture !== 'concierge-forwarder') required.push('TELEGRAM_WEBHOOK_SECRET_TOKEN');
const missing = required.filter((key) => !(process.env[key] ?? runtime[key]));
const mode = existsSync(envPath) ? (statSync(envPath).mode & 0o777).toString(8).padStart(3, '0') : null;
const branch = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim() || '(detached)';
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean).length;
const report = {
  ok: Boolean(command('node') && command('npx') && command('cloudflared') && existsSync(envPath) && missing.length === 0 && directTunnelSupported),
  branch,
  dirtyPaths: dirty,
  architecture,
  commands: { node: Boolean(command('node')), npx: Boolean(command('npx')), cloudflared: Boolean(command('cloudflared')) },
  runtimeEnv: { exists: existsSync(envPath), mode, configuredKeys: Object.values(runtime).filter(Boolean).length, missing },
  routes: { webProxy, directWebhook, concierge, directTunnelSupported },
};
console.log(JSON.stringify(report, null, 2));
if (mode && mode !== '600') console.error('runtime.env should use mode 0600');
if (!report.ok) process.exitCode = 1;
