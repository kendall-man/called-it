export function telegramInitDataFromWebApp(value: unknown): string | null {
  const webApp = telegramWebApp(value);
  return typeof webApp?.initData === 'string' && webApp.initData.length > 0
    ? webApp.initData
    : null;
}

export function initializeTelegramWebApp(value: unknown): (() => void) | null {
  const webApp = telegramWebApp(value);
  if (webApp === null) return null;

  call(webApp, 'ready');
  call(webApp, 'expand');
  const applySafeArea = () => {
    if (typeof document === 'undefined') return;
    applyInsets(document.documentElement.style, '--tg-safe-area', record(webApp.safeAreaInset));
    applyInsets(document.documentElement.style, '--tg-content-safe-area', record(webApp.contentSafeAreaInset));
  };
  applySafeArea();
  subscribe(webApp, 'safeAreaChanged', applySafeArea);
  subscribe(webApp, 'contentSafeAreaChanged', applySafeArea);
  subscribe(webApp, 'viewportChanged', applySafeArea);
  return () => {
    unsubscribe(webApp, 'safeAreaChanged', applySafeArea);
    unsubscribe(webApp, 'contentSafeAreaChanged', applySafeArea);
    unsubscribe(webApp, 'viewportChanged', applySafeArea);
  };
}

function telegramWebApp(value: unknown): Readonly<Record<string, unknown>> | null {
  const root = record(value);
  const telegram = record(root?.Telegram);
  return record(telegram?.WebApp);
}

function call(webApp: Readonly<Record<string, unknown>>, method: string): void {
  const candidate = webApp[method];
  if (typeof candidate === 'function') {
    try { candidate.call(webApp); } catch { /* Older Telegram clients may reject unsupported calls. */ }
  }
}

function subscribe(
  webApp: Readonly<Record<string, unknown>>,
  event: string,
  listener: () => void,
): void {
  const onEvent = webApp.onEvent;
  if (typeof onEvent !== 'function') return;
  try { onEvent.call(webApp, event, listener); } catch { /* Feature is unavailable in this client. */ }
}

function unsubscribe(
  webApp: Readonly<Record<string, unknown>>,
  event: string,
  listener: () => void,
): void {
  const offEvent = webApp.offEvent;
  if (typeof offEvent !== 'function') return;
  try { offEvent.call(webApp, event, listener); } catch { /* No listener was registered. */ }
}

function applyInsets(
  style: CSSStyleDeclaration,
  prefix: string,
  insets: Readonly<Record<string, unknown>> | null,
): void {
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    const value = insets?.[side];
    style.setProperty(`${prefix}-${side}`, typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? `${value}px`
      : '0px');
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}
