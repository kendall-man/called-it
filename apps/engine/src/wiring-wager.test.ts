import { describe, expect, it } from 'vitest';
import { BASE_ENV } from './env.test-fixtures.js';
import { loadEnv } from './env.js';
import type { LogFields, Logger } from './log.js';
import { TelegramFlowDb } from './points/telegram-points-flow-db.test-support.js';
import { makeFakeDeps } from './wager/fakes.js';
import { createProductionWagerModule } from './wiring-wager.js';

const PRIVATE_INVALID_OPS_CHAT = 'PRIVATE_INVALID_OPS_CHAT_VALUE';

interface CapturedWarning {
  readonly event: string;
  readonly fields: LogFields | undefined;
}

function collectingLogger(): { readonly log: Logger; readonly warnings: CapturedWarning[] } {
  const warnings: CapturedWarning[] = [];
  const log: Logger = {
    info: () => undefined,
    warn(event, fields) {
      warnings.push({ event, fields });
    },
    error: () => undefined,
    child: () => log,
  };
  return { log, warnings };
}

describe('production wager wiring', () => {
  it('logs an invalid ops chat reason without reflecting the environment value', async () => {
    // Given wager assembly with a private, invalid ops-chat environment value
    const env = loadEnv({
      ...BASE_ENV,
      WAGER_MODE_ENABLED: 'true',
      WAGER_TREASURY_KEYPAIR_B58: 'dedicated-wager-treasury',
      WAGER_OPS_CHAT_ID: PRIVATE_INVALID_OPS_CHAT,
    });
    const { db, poster } = makeFakeDeps();
    const { log, warnings } = collectingLogger();

    // When the production wager module is assembled
    await createProductionWagerModule({
      env,
      log,
      engineDb: new TelegramFlowDb(() => 0),
      poster,
      createDb: () => db,
      createConnection: (rpcUrl) => rpcUrl,
      loadTreasury: (secret) => secret,
      chainRuntime: {
        publicKey: (treasury) => treasury,
        publicKeyAddress: (publicKey) => publicKey,
        getBalance: async () => 0,
        getLatestBlockhash: async () => ({ blockhash: 'blockhash', lastValidBlockHeight: 1 }),
        sendRawTransaction: async () => 'signature',
        getSignatureStatuses: async () => ({ value: [] }),
        getBlockHeight: async () => 1,
        retry: async (operation) => operation(),
        buildSolTransfer: () => ({ ok: true, rawTxB64: 'raw', sig: 'signature' }),
        broadcastRawTx: async () => ({ ok: true }),
        getSigStatus: async () => ({ ok: true, found: false }),
        isBlockheightExceeded: async () => ({ ok: true, exceeded: false }),
        fetchIncomingTransfers: async () => ({ ok: true, transfers: [], newestSig: null }),
      },
    });

    // Then the warning preserves only a bounded reason, never the raw value
    expect(warnings.find(({ event }) => event === 'wager_ops_chat_invalid')?.fields).toEqual({
      reason: 'not_safe_integer',
    });
    expect(JSON.stringify(warnings)).not.toContain(PRIVATE_INVALID_OPS_CHAT);
  });
});
