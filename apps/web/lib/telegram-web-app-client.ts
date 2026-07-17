export function telegramInitDataFromWebApp(value: unknown): string | null {
  const webApp = telegramWebApp(value);
  return typeof webApp?.initData === 'string' && webApp.initData.length > 0
    ? webApp.initData
    : null;
}

// Routing hint only: authoritative start_param parsing happens server-side
// from the HMAC-verified initData string.
export function telegramStartParamFromWebApp(value: unknown): string | null {
  const unsafe = record(telegramWebApp(value)?.initDataUnsafe);
  const startParam = unsafe?.start_param;
  return typeof startParam === 'string' && startParam.length > 0 ? startParam : null;
}

export function triggerTelegramHapticNotification(
  value: unknown,
  type: 'success' | 'error',
): void {
  const haptic = record(telegramWebApp(value)?.HapticFeedback);
  const notify = haptic?.notificationOccurred;
  if (typeof notify !== 'function') return;
  try { notify.call(haptic, type); } catch { /* Optional feedback; older clients may reject it. */ }
}

export function setTelegramClosingConfirmation(value: unknown, enabled: boolean): void {
  const webApp = telegramWebApp(value);
  if (webApp === null) return;
  call(webApp, enabled ? 'enableClosingConfirmation' : 'disableClosingConfirmation');
}

/** Returns true only when the Telegram bridge accepted the close request. */
export function closeTelegramWebApp(value: unknown): boolean {
  const webApp = telegramWebApp(value);
  const close = webApp?.close;
  if (webApp === null || typeof close !== 'function') return false;
  try {
    close.call(webApp);
    return true;
  } catch {
    return false;
  }
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
