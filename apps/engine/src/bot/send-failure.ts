import { TUNABLES } from '@calledit/market-engine';
import { GrammyError } from 'grammy';
import { ENGINE } from '../engineConstants.js';
import type { Logger } from '../log.js';
import { SendQueue } from './sendQueue.js';

export type SendFailureFields =
  | {
      readonly failureKind: 'telegram_api';
      readonly telegramMethod: 'send_message' | 'other';
      readonly telegramErrorCode: number;
      readonly reason: 'button_url_invalid' | 'telegram_api_error';
    }
  | { readonly failureKind: 'unknown' };

export function classifySendFailure(error: unknown): SendFailureFields {
  if (!(error instanceof GrammyError)) return { failureKind: 'unknown' };
  return {
    failureKind: 'telegram_api',
    telegramMethod: error.method === 'sendMessage' ? 'send_message' : 'other',
    telegramErrorCode: error.error_code,
    reason: error.description.includes('BUTTON_URL_INVALID')
      ? 'button_url_invalid'
      : 'telegram_api_error',
  };
}

export function logSendFailure(log: Logger, error: unknown): void {
  log.error('send_failed', classifySendFailure(error));
}

export function createEngineSendQueue(log: Logger): SendQueue {
  return new SendQueue({
    ratePerMinute: ENGINE.SEND_RATE_PER_MINUTE,
    collapseMs: TUNABLES.CARD_EDIT_COLLAPSE_MS,
    onError: (error) => logSendFailure(log, error),
  });
}
