import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const root = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '');
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const action = args[0] ?? 'status';
const envPath = process.env.CALLEDIT_RUNTIME_ENV ?? `${root}/.calledit-local/runtime.env`;
const runtime = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {};
const token = process.env.TELEGRAM_BOT_TOKEN ?? runtime.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN ?? runtime.TELEGRAM_WEBHOOK_SECRET_TOKEN;
if (!token) throw new Error('Missing TELEGRAM_BOT_TOKEN');
const api = `https://api.telegram.org/bot${token}`;
const call = async (method, body) => {
  const response = await fetch(`${api}/${method}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const json = await response.json();
  if (!json.ok) throw new Error(`Telegram ${method} failed: ${json.description ?? response.status}`);
  return json.result;
};
if (action === 'status') {
  const info = await call('getWebhookInfo');
  let endpoint = null;
  try { const url = new URL(info.url); endpoint = `${url.host}${url.pathname}`; } catch {}
  console.log(JSON.stringify({ endpoint, pending: info.pending_update_count ?? 0, lastError: info.last_error_message ?? null }, null, 2));
} else if (action === 'set') {
  if (!secret) throw new Error('Missing TELEGRAM_WEBHOOK_SECRET_TOKEN');
  const publicOrigin = process.env.CALLEDIT_PUBLIC_ORIGIN ?? (existsSync(`${root}/.calledit-local/web-tunnel-url`) ? readFileSync(`${root}/.calledit-local/web-tunnel-url`, 'utf8').trim() : null);
  if (!publicOrigin) throw new Error('Start the tunnel or set CALLEDIT_PUBLIC_ORIGIN');
  const path = process.env.CALLEDIT_WEBHOOK_PATH ?? '/api/telegram-webhook';
  await call('setWebhook', { url: new URL(path, publicOrigin).toString(), secret_token: secret, drop_pending_updates: false, allowed_updates: ['message', 'callback_query', 'my_chat_member'] });
  console.log(JSON.stringify({ configured: true, endpoint: `${new URL(publicOrigin).host}${path}` }, null, 2));
} else if (action === 'clear') {
  await call('deleteWebhook', { drop_pending_updates: false });
  console.log(JSON.stringify({ cleared: true }, null, 2));
} else {
  throw new Error('Usage: pnpm local:webhook -- <set|status|clear>');
}
