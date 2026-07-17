import { spawn } from 'node:child_process';
import { defaultJourneyProfilePath, loadJourneyProfile } from './local-journey-profile.mjs';
import { superviseStack } from './local-stack-supervisor.mjs';

const workspace = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
const profile = loadJourneyProfile(defaultJourneyProfilePath(workspace), workspace);
const runtime = profile.runtime;
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
const engine = spawn('npx', [
  '-y', 'pnpm@10.33.0', '--filter', '@calledit/engine', 'exec', 'tsx', 'src/main.ts',
], {
  cwd: workspace,
  env: { ...common, PORT: String(profile.services.engine.port), HOSTNAME: profile.services.engine.host },
  stdio: 'inherit',
});
const web = spawn('npx', [
  '-y', 'pnpm@10.33.0', '--dir', 'apps/web', 'exec', 'next', 'dev',
  '--hostname', profile.services.web.host, '--port', String(profile.services.web.port),
], {
  cwd: workspace,
  env: { ...common, PORT: String(profile.services.web.port), HOSTNAME: profile.services.web.host },
  stdio: 'inherit',
});

const stop = superviseStack([engine, web], {
  onUnexpectedExit: (code) => { process.exitCode = code === 0 ? 1 : code; },
});
const handleSignal = () => {
  stop();
  setTimeout(() => process.exit(0), 2_000).unref();
};
process.on('SIGINT', handleSignal);
process.on('SIGTERM', handleSignal);
