import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs, parseEnv } from 'node:util';

const root = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '');
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const { values } = parseArgs({ args, options: { env: { type: 'string' }, webhook: { type: 'boolean', default: false } } });
const envPath = values.env ?? process.env.CALLEDIT_RUNTIME_ENV ?? `${root}/.calledit-local/runtime.env`;
if (!existsSync(envPath)) throw new Error(`Missing runtime env: ${envPath}`);
const runtime = parseEnv(readFileSync(envPath, 'utf8'));
const originPath = `${root}/.calledit-local/origin.env`;
const origin = existsSync(originPath) ? parseEnv(readFileSync(originPath, 'utf8')) : {};
const common = {
  ...process.env,
  ...runtime,
  ...origin,
  ENGINE_INTERNAL_ORIGIN: runtime.ENGINE_INTERNAL_ORIGIN ?? 'http://127.0.0.1:8790',
  TELEGRAM_INGRESS: values.webhook ? 'webhook' : (runtime.TELEGRAM_INGRESS ?? 'poll'),
  CALLEDIT_ENV_PRELOADED: 'true',
};
if (values.webhook && !common.TELEGRAM_WEBHOOK_SECRET_TOKEN) throw new Error('Webhook mode requires TELEGRAM_WEBHOOK_SECRET_TOKEN');
const pnpm = ['-y', 'pnpm@10.33.0'];
const children = [
  spawn('npx', [...pnpm, '--filter', '@calledit/engine', 'exec', 'tsx', 'src/main.ts'], { cwd: root, env: { ...common, PORT: '8790' }, stdio: 'inherit' }),
  spawn('npx', [...pnpm, '--dir', 'apps/web', 'exec', 'next', 'dev', '--hostname', '127.0.0.1', '--port', '3020'], { cwd: root, env: { ...common, PORT: '3020', HOSTNAME: '127.0.0.1' }, stdio: 'inherit' }),
];
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(), 2_000).unref();
};
for (const child of children) child.on('exit', (code) => { if (!stopping && code !== 0) { process.exitCode = code ?? 1; stop(); } });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
