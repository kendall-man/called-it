/**
 * Inline-keyboard callback_data codec. Telegram caps callback_data at
 * 64 bytes, so actions are short-prefixed and carry DB ids (uuid = 36 chars).
 * Every tap resolves against the database via these ids — no in-memory
 * conversation state (PRD: survives restarts; stale taps decline in character).
 */

import type { Chattiness } from '../localTypes.js';

export const CALLBACK_DATA_MAX_BYTES = 64;

export type CallbackAction =
  /** "Make him prove it" on a nudge. */
  | { t: 'prove'; claimId: string }
  /** Clarify / counter-offer option pick; key indexes the stored candidates. */
  | { t: 'option'; claimId: string; key: string }
  /** "That's my shout" confirm gate. */
  | { t: 'confirm'; claimId: string }
  /** Claimer walks away from the confirm gate. */
  | { t: 'decline'; claimId: string }
  /** Back/Doubt stake tap with a preset index into TUNABLES.PRESET_STAKES. */
  | { t: 'stake'; marketId: string; side: 'back' | 'doubt'; presetIndex: number }
  /** /settings chattiness pick. */
  | { t: 'chattiness'; mode: Chattiness }
  /** /settings web-pages toggle. */
  | { t: 'web'; enabled: boolean }
  /** /settings devnet-SOL toggle (admin, only offered when the wager module is live). */
  | { t: 'wager'; enabled: boolean };

const MODE_TO_CODE: Record<Chattiness, string> = {
  nudge: 'n',
  react_only: 'r',
  trigger_only: 't',
};
const CODE_TO_MODE: Record<string, Chattiness> = {
  n: 'nudge',
  r: 'react_only',
  t: 'trigger_only',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCallback(action: CallbackAction): string {
  let data: string;
  switch (action.t) {
    case 'prove':
      data = `pv:${action.claimId}`;
      break;
    case 'option':
      data = `op:${action.claimId}:${action.key}`;
      break;
    case 'confirm':
      data = `cf:${action.claimId}`;
      break;
    case 'decline':
      data = `nx:${action.claimId}`;
      break;
    case 'stake':
      data = `st:${action.marketId}:${action.side === 'back' ? 'b' : 'd'}:${action.presetIndex}`;
      break;
    case 'chattiness':
      data = `sg:${MODE_TO_CODE[action.mode]}`;
      break;
    case 'web':
      data = `sw:${action.enabled ? '1' : '0'}`;
      break;
    case 'wager':
      data = `wg:${action.enabled ? '1' : '0'}`;
      break;
  }
  if (Buffer.byteLength(data, 'utf8') > CALLBACK_DATA_MAX_BYTES) {
    throw new Error(`callback_data exceeds ${CALLBACK_DATA_MAX_BYTES} bytes: ${data}`);
  }
  return data;
}

/** Returns null for anything malformed or from an older build — callers treat null as a stale tap. */
export function decodeCallback(data: string): CallbackAction | null {
  const parts = data.split(':');
  const prefix = parts[0];
  switch (prefix) {
    case 'pv': {
      const claimId = parts[1];
      return parts.length === 2 && claimId !== undefined && UUID_RE.test(claimId)
        ? { t: 'prove', claimId }
        : null;
    }
    case 'cf': {
      const claimId = parts[1];
      return parts.length === 2 && claimId !== undefined && UUID_RE.test(claimId)
        ? { t: 'confirm', claimId }
        : null;
    }
    case 'nx': {
      const claimId = parts[1];
      return parts.length === 2 && claimId !== undefined && UUID_RE.test(claimId)
        ? { t: 'decline', claimId }
        : null;
    }
    case 'op': {
      const claimId = parts[1];
      const key = parts[2];
      return parts.length === 3 &&
        claimId !== undefined &&
        UUID_RE.test(claimId) &&
        key !== undefined &&
        key.length > 0 &&
        key.length <= 8
        ? { t: 'option', claimId, key }
        : null;
    }
    case 'st': {
      const marketId = parts[1];
      const sideCode = parts[2];
      const idxRaw = parts[3];
      if (parts.length !== 4 || marketId === undefined || !UUID_RE.test(marketId)) return null;
      if (sideCode !== 'b' && sideCode !== 'd') return null;
      if (idxRaw === undefined || !/^\d$/.test(idxRaw)) return null;
      return {
        t: 'stake',
        marketId,
        side: sideCode === 'b' ? 'back' : 'doubt',
        presetIndex: Number(idxRaw),
      };
    }
    case 'sg': {
      const code = parts[1];
      const mode = code !== undefined ? CODE_TO_MODE[code] : undefined;
      return parts.length === 2 && mode !== undefined ? { t: 'chattiness', mode } : null;
    }
    case 'sw': {
      const flag = parts[1];
      return parts.length === 2 && (flag === '0' || flag === '1')
        ? { t: 'web', enabled: flag === '1' }
        : null;
    }
    case 'wg': {
      const flag = parts[1];
      return parts.length === 2 && (flag === '0' || flag === '1')
        ? { t: 'wager', enabled: flag === '1' }
        : null;
    }
    default:
      return null;
  }
}
