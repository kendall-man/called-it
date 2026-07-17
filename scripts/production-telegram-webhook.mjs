const ALLOWED_UPDATES = ['message', 'callback_query', 'my_chat_member'];

const required = (source, name) => {
  const value = source[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`Production webhook environment invalid: ${name}`);
  }
  return value.trim();
};

export const productionWebhookUrl = (source = process.env) => {
  const domain = required(source, 'RAILWAY_PUBLIC_DOMAIN');
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(domain)) {
    throw new TypeError('Production webhook environment invalid: RAILWAY_PUBLIC_DOMAIN');
  }
  return `https://${domain}/api/telegram-webhook`;
};

const telegramCall = async (fetchImpl, token, method, body) => {
  let response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error(`Telegram ${method} request failed`);
  }
  const result = await response.json();
  if (!response.ok || result?.ok !== true) throw new Error(`Telegram ${method} failed`);
  return result.result;
};

export async function configureProductionWebhook(
  source = process.env,
  fetchImpl = fetch,
) {
  if (source.DEPLOYMENT_ENV !== 'production') {
    throw new TypeError('Production webhook environment invalid: DEPLOYMENT_ENV');
  }
  const token = required(source, 'TELEGRAM_BOT_TOKEN');
  const secret = required(source, 'TELEGRAM_WEBHOOK_SECRET_TOKEN');
  if (secret.length < 32) {
    throw new TypeError('Production webhook environment invalid: TELEGRAM_WEBHOOK_SECRET_TOKEN');
  }
  const url = productionWebhookUrl(source);
  await telegramCall(fetchImpl, token, 'setWebhook', {
    url,
    secret_token: secret,
    drop_pending_updates: false,
    allowed_updates: ALLOWED_UPDATES,
  });
  const info = await telegramCall(fetchImpl, token, 'getWebhookInfo');
  if (info?.url !== url || info?.last_error_message) {
    throw new Error('Production webhook verification failed');
  }
  const endpoint = new URL(url);
  return {
    configured: true,
    endpoint: `${endpoint.host}${endpoint.pathname}`,
    pending: info.pending_update_count ?? 0,
    lastError: null,
  };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const result = await configureProductionWebhook();
  console.log(JSON.stringify(result, null, 2));
}
