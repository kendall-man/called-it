import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const root = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '');
const state = `${root}/.calledit-local`;
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const action = args[0] ?? 'status';
const target = process.env.CALLEDIT_TUNNEL_TARGET ?? 'http://127.0.0.1:3020';
const pidPath = `${state}/tunnel.pid`;
const logPath = `${state}/tunnel.log`;
const urlPath = `${state}/web-tunnel-url`;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const savedPid = () => existsSync(pidPath) ? Number(readFileSync(pidPath, 'utf8').trim()) : null;
const savedUrl = () => existsSync(urlPath) ? readFileSync(urlPath, 'utf8').trim() : null;
const safeTunnelPid = (pid) => {
  if (!pid || !alive(pid)) return false;
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).includes('cloudflared tunnel'); }
  catch { return false; }
};
if (action === 'status') {
  const pid = savedPid();
  console.log(JSON.stringify({ running: safeTunnelPid(pid), pid, url: savedUrl(), target }, null, 2));
  process.exit(safeTunnelPid(pid) ? 0 : 1);
}
if (action === 'stop') {
  const pid = savedPid();
  if (safeTunnelPid(pid)) process.kill(pid, 'SIGTERM');
  console.log(JSON.stringify({ stopped: Boolean(pid), pid }, null, 2));
  process.exit();
}
if (action !== 'start') throw new Error('Usage: pnpm local:tunnel -- <start|status|stop>');
mkdirSync(state, { recursive: true, mode: 0o700 });
const existing = savedPid();
if (safeTunnelPid(existing)) throw new Error(`Tunnel already running with PID ${existing}`);
try { await fetch(target, { method: 'HEAD', signal: AbortSignal.timeout(3_000) }); }
catch { throw new Error(`Tunnel target is not reachable: ${target}`); }
const fd = openSync(logPath, 'w', 0o600);
const child = spawn('cloudflared', ['tunnel', '--url', target, '--no-autoupdate'], { cwd: root, detached: true, stdio: ['ignore', fd, fd] });
closeSync(fd);
child.unref();
writeFileSync(pidPath, `${child.pid}\n`, { mode: 0o600 });
let url = null;
for (let attempt = 0; attempt < 80; attempt += 1) {
  await delay(250);
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  url = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)?.[0] ?? null;
  if (url) break;
  if (!alive(child.pid)) throw new Error(`cloudflared exited; inspect ${logPath}`);
}
if (!url) throw new Error(`Tunnel URL deadline exceeded; inspect ${logPath}`);
writeFileSync(urlPath, `${url}\n`, { mode: 0o600 });
writeFileSync(`${state}/origin.env`, `WEB_BASE_URL=${url}\n`, { mode: 0o600 });
console.log(JSON.stringify({ running: true, pid: child.pid, url, target, restartStack: true }, null, 2));
