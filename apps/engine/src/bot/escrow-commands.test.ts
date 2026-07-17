import { describe, expect, it } from 'vitest';
import {
  registerEscrowAccountCommands,
  type EscrowAccountCommandContext,
  type EscrowAccountCommandBot,
} from './escrow-commands.js';
import type { EscrowTelegramPort } from './escrow-ux.js';

const TOKEN = 'b'.repeat(43);

function port(): EscrowTelegramPort {
  return {
    async createPlacementSession() {
      return { kind: 'rejected', code: 'temporarily_unavailable' };
    },
    async createWalletSession() {
      return {
        kind: 'created',
        token: TOKEN,
        expiresAt: '2026-07-06T18:05:00.000Z',
        legacyRecoveryUrl: 'https://web.test/legacy/recovery',
      };
    },
  };
}

describe('escrow account commands', () => {
  it('opens the Privy account manager privately without registering custody commands', async () => {
    const handlers = new Map<string, (ctx: EscrowAccountCommandContext) => Promise<void>>();
    const bot: EscrowAccountCommandBot = {
      command(name, handler) {
        handlers.set(name, handler);
      },
    };
    const replies: Array<{ readonly text: string; readonly options: unknown }> = [];
    registerEscrowAccountCommands(bot, {
      webBaseUrl: 'https://web.test/base',
      network: 'mainnet-beta',
      escrow: port(),
      ensureUser: async () => undefined,
      now: () => Date.parse('2026-07-06T18:00:00.000Z'),
    });
    const wallet = handlers.get('wallet');
    if (wallet === undefined) throw new Error('wallet handler missing');

    await wallet({
      chat: { id: 42, type: 'private' },
      from: { id: 42, first_name: 'Alice' },
      async reply(text, options) {
        replies.push({ text, options });
      },
    });

    expect([...handlers.keys()]).toEqual(['wallet']);
    expect(replies[0]?.text).toContain('Privy wallet');
    expect(replies[0]?.text).toContain('On-chain escrow · MAINNET');
    expect(replies[0]?.text).not.toContain(TOKEN);
    expect(JSON.stringify(replies[0]?.options)).toContain(`/base/wallet/${TOKEN}`);
    expect(replies[0]?.options).toEqual({
      reply_markup: {
        inline_keyboard: [
          [{
            text: 'Open Privy wallet',
            web_app: { url: `https://web.test/base/wallet/${TOKEN}` },
          }],
          [{
            text: 'Legacy balance recovery',
            url: 'https://web.test/legacy/recovery',
          }],
        ],
      },
    });
    expect(JSON.stringify(replies[0]?.options)).toContain('Legacy balance recovery');
  });
});
