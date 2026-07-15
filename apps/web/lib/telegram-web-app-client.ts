export function telegramInitDataFromWebApp(value: unknown): string | null {
  const root = record(value);
  const telegram = record(root?.Telegram);
  const webApp = record(telegram?.WebApp);
  return typeof webApp?.initData === 'string' && webApp.initData.length > 0
    ? webApp.initData
    : null;
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}
