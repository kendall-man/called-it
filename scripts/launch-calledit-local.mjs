import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const workspace = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
const runtimePath = `${workspace}/.calledit-local/runtime.env`;
const runtime = parseEnv(readFileSync(runtimePath, 'utf8'));
const required = [
  'WEB_BASE_URL',
  'PRIVY_APP_SECRET',
  'WALLET_AUTH_PRIVATE_KEY',
  'WALLET_AUTH_KEY_ID',
  'WEB_CONCIERGE_TOKEN',
  'ENGINE_INTERNAL_ORIGIN',
];
for (const name of required) {
  if (!runtime[name]) throw new Error(`Stable runtime is missing ${name}`);
}
if (runtime.PRIVY_APP_SECRET.length < 16) {
  throw new Error('Stable runtime contains an invalid PRIVY_APP_SECRET');
}

const common = { ...process.env, ...runtime, CALLEDIT_ENV_PRELOADED: 'true' };
const engine = spawn('/opt/homebrew/bin/npx', [
  '-y', 'pnpm@10.33.0', '--filter', '@calledit/engine', 'exec', 'tsx', 'src/main.ts',
], {
  cwd: workspace,
  env: { ...common, PORT: '8790' },
  stdio: 'inherit',
});
const web = spawn('/opt/homebrew/bin/npx', [
  '-y', 'pnpm@10.33.0', '--dir', 'apps/web', 'exec', 'next', 'dev',
  '--hostname', '127.0.0.1', '--port', '3020',
], {
  cwd: workspace,
  env: { ...common, PORT: '3020', HOSTNAME: '127.0.0.1' },
  stdio: 'inherit',
});

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  engine.kill('SIGTERM');
  web.kill('SIGTERM');
  setTimeout(() => process.exit(0), 2_000).unref();
};
engine.on('exit', (code) => { if (!stopping && code !== 0) process.exitCode = code ?? 1; });
web.on('exit', (code) => { if (!stopping && code !== 0) process.exitCode = code ?? 1; });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
