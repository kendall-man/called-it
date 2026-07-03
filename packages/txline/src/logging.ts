/**
 * Minimal injectable logger so library consumers (apps/engine, tests) decide
 * where diagnostics go. TxLINE feed quirks (unknown SuperOddsType strings,
 * unparseable records) are logged, never thrown — the feed must keep flowing.
 */
export type TxlineLogger = (message: string, context?: Record<string, unknown>) => void;

export const consoleLogger: TxlineLogger = (message, context) => {
  if (context === undefined) {
    console.warn(`[txline] ${message}`);
  } else {
    console.warn(`[txline] ${message}`, context);
  }
};

export const silentLogger: TxlineLogger = () => {};
