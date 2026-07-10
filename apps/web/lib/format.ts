/** Consumer-facing number/date formatting. Game-show register: "×9 back", never odds notation. */

const REP_FORMAT = new Intl.NumberFormat('en-US');

/** Fixed-locale, fixed-zone date formatting so server and client render identically. */
const UTC_DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
});

const MULTIPLIER_DECIMALS = 1;
const PERCENT_FLOOR = 1;

export function formatRep(points: number): string {
  return REP_FORMAT.format(points);
}

/** Renders as "×9" (whole) or "×9.4" — never bookmaker odds notation. */
export function formatMultiplier(multiplier: number): string {
  const rounded =
    Math.round(multiplier * 10 ** MULTIPLIER_DECIMALS) / 10 ** MULTIPLIER_DECIMALS;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(MULTIPLIER_DECIMALS);
  return `×${text}`;
}

export function formatLamportsAsSol(lamports: string): string {
  const normalized = lamports.replace(/^0+(?=\d)/, '');
  const padded = normalized.padStart(10, '0');
  const whole = padded.slice(0, -9).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fractional = padded.slice(-9).replace(/0+$/, '');
  return `${fractional === '' ? whole : `${whole}.${fractional}`} SOL`;
}

/** probability in [0,1] → "9%", clamped and floored at "<1%". */
export function formatProbabilityPct(probability: number): string {
  const clamped = Math.min(Math.max(probability, 0), 1);
  const pct = Math.round(clamped * 100);
  if (pct < PERCENT_FLOOR && clamped > 0) return '<1%';
  return `${pct}%`;
}

export function formatUtc(isoTimestamp: string): string {
  const parsed = Date.parse(isoTimestamp);
  if (Number.isNaN(parsed)) return '';
  return `${UTC_DATE_FORMAT.format(parsed)} UTC`;
}
