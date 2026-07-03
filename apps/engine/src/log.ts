/**
 * Structured JSON-lines logger. Every detection, parse, compile, price,
 * freeze, and settlement decision is logged through this so a disputed market
 * can be reconstructed after the fact (PRD story 52).
 */

export type LogFields = Record<string, unknown>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(bound: LogFields): Logger;
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, val: unknown) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[circular]';
        seen.add(val);
      }
      if (typeof val === 'bigint') return val.toString();
      if (val instanceof Error) return { message: val.message, stack: val.stack };
      return val;
    });
  } catch {
    return '{"event":"log_serialize_failed"}';
  }
}

function emit(level: 'info' | 'warn' | 'error', event: string, fields: LogFields): void {
  const line = safeStringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export function createLogger(bound: LogFields = {}): Logger {
  return {
    info: (event, fields = {}) => emit('info', event, { ...bound, ...fields }),
    warn: (event, fields = {}) => emit('warn', event, { ...bound, ...fields }),
    error: (event, fields = {}) => emit('error', event, { ...bound, ...fields }),
    child: (extra) => createLogger({ ...bound, ...extra }),
  };
}
