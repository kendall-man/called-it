import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BASE_ENV } from './env.test-fixtures.js';
import { EngineEnvironmentError, loadEnv, type Env } from './env.js';
import type { LogFields, Logger } from './log.js';
import { TelegramFlowDb } from './points/telegram-points-flow-db.test-support.js';
import { makeFakeDeps, type FakeWagerDb } from './wager/fakes.js';
import type { WagerPoster } from './wager/module.js';
import type { WagerDepositScan } from './wager/port.js';
import { starterOnlyWagerDbFromFake } from './wager/starter-fake.test-support.js';
import { createStarterOnlyWagerModule } from './wager/starter-only-module.js';
import { createProductionFundedWagerModule } from './wiring-wager-funded.js';
import { createProductionWagerRuntime } from './wiring-wager-runtime.js';
import {
  createProductionWagerModule,
  type ProductionWagerFactories,
} from './wiring-wager.js';

const PRIVATE_INVALID_OPS_CHAT = 'PRIVATE_INVALID_OPS_CHAT_VALUE';
const PRODUCTION_WIRING_SOURCE = new URL('./wiring.ts', import.meta.url);
const WAGER_RUNTIME_SOURCE = new URL('./wiring-wager-runtime.ts', import.meta.url);
const STARTER_MODULE_SOURCES = [
  new URL('./wager/starter-only-module.ts', import.meta.url),
  new URL('./wager/module-core.ts', import.meta.url),
  new URL('./wiring-wager-starter-db.ts', import.meta.url),
] as const;
type StarterFactoryParameters = Parameters<ProductionWagerFactories['starterOnly']>;

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

function fundedWagerOptions(options: {
  readonly env: Env;
  readonly log: Logger;
  readonly db: FakeWagerDb;
  readonly poster: WagerPoster;
}) {
  return {
    env: options.env,
    log: options.log,
    engineDb: new TelegramFlowDb(() => 0),
    poster: options.poster,
    createDb: () => options.db,
    createConnection: (rpcUrl: string) => rpcUrl,
    loadTreasury: (secret: string) => secret,
    chainRuntime: {
      publicKey: (treasury: string) => treasury,
      publicKeyAddress: (publicKey: string) => publicKey,
      getBalance: async () => 0,
      getLatestBlockhash: async () => ({ blockhash: 'blockhash', lastValidBlockHeight: 1 }),
      sendRawTransaction: async () => 'signature',
      getSignatureStatuses: async () => ({ value: [] }),
      getBlockHeight: async () => 1,
      retry: async <Result>(operation: () => Promise<Result>) => operation(),
      buildSolTransfer: () => ({ ok: true, rawTxB64: 'raw', sig: 'signature' } as const),
      broadcastRawTx: async () => ({ ok: true } as const),
      getSigStatus: async () => ({ ok: true, found: false } as const),
      isBlockheightExceeded: async () => ({ ok: true, exceeded: false } as const),
      fetchIncomingTransfers: async (): Promise<WagerDepositScan> => ({
        ok: true,
        transfers: [],
        newestSig: null,
      }),
    },
  };
}

describe('production wager wiring', () => {
  it('dispatches starter-only through its zero-authority factory before funded construction', async () => {
    // Given separate mode-specific factories
    const calls: string[] = [];
    const { db, deps } = makeFakeDeps();
    const starterFactoryHasNoParameters: StarterFactoryParameters extends []
      ? true
      : false = true;

    // When starter-only construction is selected
    const module = await createProductionWagerModule('starter_only', {
      starterOnly: () => {
        calls.push('starter');
        return createStarterOnlyWagerModule({
          runtimeMode: 'starter_only',
          db: starterOnlyWagerDbFromFake(db),
          log: deps.log,
          starterGrantsEnabled: true,
          stakeAcceptanceEnabled: true,
        });
      },
      funded: () => {
        calls.push('funded');
        return null;
      },
    });

    // Then no funded constructor is reachable from the selected branch
    expect(module?.kind).toBe('starter_only');
    expect(starterFactoryHasNoParameters).toBe(true);
    expect(calls).toEqual(['starter']);
  });

  it('keeps sibling package factories in wiring and funded loaders behind the funded branch', () => {
    // Given the production composition source
    const wiringSource = readFileSync(PRODUCTION_WIRING_SOURCE, 'utf8');
    const runtimeSource = readFileSync(WAGER_RUNTIME_SOURCE, 'utf8');

    // When its wager factories are inspected
    const fundedFactoryIndex = runtimeSource.indexOf('funded: async () => {');
    const fundedDbLoaderIndex = runtimeSource.indexOf('factories.loadFundedDbFactory()');
    const solanaRuntimeLoaderIndex = runtimeSource.indexOf(
      'factories.loadFundedSolanaRuntime()',
    );
    const runtimeCompositionIndex = wiringSource.indexOf('createProductionWagerRuntime(');
    const proofConnectionIndex = wiringSource.indexOf('new Connection(');

    // Then package imports stay in the hub and injected loaders run only in the funded branch
    expect(wiringSource).toContain("import('@calledit/db/wager-funded')");
    expect(wiringSource).toContain("import('@calledit/solana')");
    expect(runtimeSource).not.toContain('@calledit/');
    expect(fundedFactoryIndex).toBeGreaterThan(-1);
    expect(fundedDbLoaderIndex).toBeGreaterThan(fundedFactoryIndex);
    expect(solanaRuntimeLoaderIndex).toBeGreaterThan(fundedFactoryIndex);
    expect(runtimeCompositionIndex).toBeLessThan(proofConnectionIndex);
  });

  it('constructs starter-only without loading treasury or chain custody', async () => {
    // Given a starter-only beta with only starter and settlement DB capabilities
    const env = loadEnv({
      ...BASE_ENV,
      WAGER_RUNTIME_MODE: 'starter_only',
      BETA_ALLOWED_GROUP_IDS: '-100123',
      WEB_BASE_URL: 'https://web.example.test',
      WALLET_LINK_DOMAIN: 'web.example.test',
      STARTER_GRANTS_ENABLED: 'true',
      STAKE_ACCEPTANCE_ENABLED: 'true',
    });
    const { db } = makeFakeDeps();
    const { log } = collectingLogger();
    db.stakeResult = { ok: true, position_id: 'starter-position' };

    // When the production module is assembled
    const module = await createProductionWagerRuntime(
      { env, log, engineDb: new TelegramFlowDb(() => 0) },
      {
        loadStarterOnlyDbFactory: () => () => starterOnlyWagerDbFromFake(db),
        loadFundedDbFactory: () => {
          throw new TypeError('funded DB factory reached from starter-only mode');
        },
        loadFundedSolanaRuntime: () => {
          throw new TypeError('funded chain factory reached from starter-only mode');
        },
      },
    );

    // Then only the DB-only starter module exists and the fixed Telegram flow remains live
    expect(module?.kind).toBe('starter_only');
    expect('walletSummary' in (module ?? {})).toBe(false);
    expect('registerCommands' in (module ?? {})).toBe(false);
    expect('registerFundedWorkers' in (module ?? {})).toBe(false);
    await expect(module?.handleStakeTap({
      market: {
        id: 'starter-market',
        group_id: -100123,
        status: 'open',
        quote_probability: 0.5,
        quote_multiplier: 2,
      },
      userId: 7,
      userName: 'Starter',
      side: 'back',
      lamports: 10_000_000n,
      inPlay: false,
      nowMs: 1,
      source: { kind: 'telegram_default_card', callbackId: 'starter-callback' },
    })).resolves.toMatchObject({ placed: true });
    const productionWiring = readFileSync(PRODUCTION_WIRING_SOURCE, 'utf8');
    expect(productionWiring).toContain("import('@calledit/db/wager-starter')");
    expect(productionWiring).toContain("import('@calledit/db/wager-funded')");
    expect(productionWiring).not.toMatch(
      /import \{[^}]*createWagerDb[^}]*\} from '@calledit\/db'/,
    );
    for (const source of STARTER_MODULE_SOURCES) {
      expect(readFileSync(source, 'utf8')).not.toMatch(
        /from '\.\/(?:deposits|module|solvency|withdrawals)\.js'/,
      );
    }
  });

  it('rejects starter grants before direct funded construction', async () => {
    // Given a structurally forged funded environment that bypassed loadEnv validation
    const validEnv = loadEnv({
      ...BASE_ENV,
      WAGER_RUNTIME_MODE: 'funded',
      WAGER_MODE_ENABLED: 'true',
      WAGER_TREASURY_KEYPAIR_B58: 'dedicated-wager-treasury',
      STAKE_ACCEPTANCE_ENABLED: 'true',
      TREASURY_COVERAGE_ENFORCED: 'true',
    });
    const env = { ...validEnv, STARTER_GRANTS_ENABLED: true };
    const { db, poster } = makeFakeDeps();
    const { log } = collectingLogger();

    // When the funded factory is called directly
    const construction = createProductionFundedWagerModule(
      fundedWagerOptions({ env, log, db, poster }),
    );

    // Then the same bounded configuration error fails closed
    await expect(construction).rejects.toEqual(
      new EngineEnvironmentError(['STARTER_GRANTS_ENABLED']),
    );
  });

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
    await createProductionFundedWagerModule(fundedWagerOptions({ env, log, db, poster }));

    // Then the warning preserves only a bounded reason, never the raw value
    expect(warnings.find(({ event }) => event === 'wager_ops_chat_invalid')?.fields).toEqual({
      reason: 'not_safe_integer',
    });
    expect(JSON.stringify(warnings)).not.toContain(PRIVATE_INVALID_OPS_CHAT);
  });
});
