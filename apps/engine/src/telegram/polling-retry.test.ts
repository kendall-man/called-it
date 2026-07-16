import { describe, expect, it, vi } from 'vitest';
import { withRetryablePollingConflict } from './polling-retry.js';

describe('withRetryablePollingConflict', () => {
  it('normalizes the raw Telegram response seen by API transformers', async () => {
    const onConflict = vi.fn();

    await expect(withRetryablePollingConflict(
      'getUpdates',
      async () => ({ ok: false, error_code: 409 }),
      onConflict,
    )).rejects.toMatchObject({ message: 'telegram polling overlap; retrying' });
    expect(onConflict).toHaveBeenCalledOnce();
  });

  it('turns only getUpdates 409 conflicts into retryable errors', async () => {
    const onConflict = vi.fn();
    const conflict = { error_code: 409, description: 'another poller is active' };

    const action = withRetryablePollingConflict(
      'getUpdates',
      async () => Promise.reject(conflict),
      onConflict,
    );

    await expect(action).rejects.toMatchObject({
      message: 'telegram polling overlap; retrying',
    });
    await expect(action).rejects.not.toHaveProperty('error_code');
    expect(onConflict).toHaveBeenCalledOnce();
  });

  it('preserves authentication failures and non-polling conflicts', async () => {
    const onConflict = vi.fn();
    const unauthorized = { error_code: 401 };
    const sendConflict = { error_code: 409 };

    await expect(withRetryablePollingConflict(
      'getUpdates',
      async () => Promise.reject(unauthorized),
      onConflict,
    )).rejects.toBe(unauthorized);
    await expect(withRetryablePollingConflict(
      'sendMessage',
      async () => Promise.reject(sendConflict),
      onConflict,
    )).rejects.toBe(sendConflict);
    expect(onConflict).not.toHaveBeenCalled();
  });
});
