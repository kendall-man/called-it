import { describe, expect, it } from 'vitest';
import { base58Encode } from '@calledit/solana';
import { createWagerModule } from './module.js';
import { WAGER_COPY } from './copy.js';
import { WAGER_KEYS, WAGER_TUNABLES } from './constants.js';
import { makeFakeDeps } from './fakes.js';
import type { WagerCommandCtx, WagerCronRegistry, WagerMarketRow } from './port.js';

const USER = 11;
const GROUP = -400;
const VALID_PUBKEY = base58Encode(new Uint8Array(32).fill(7));

interface FakeCommandBot {
  handlers: Map<string, (ctx: WagerCommandCtx) => Promise<void>>;
  command(name: string, handler: (ctx: WagerCommandCtx) => Promise<void>): void;
}

function fakeBot(): FakeCommandBot {
  const handlers = new Map<string, (ctx: WagerCommandCtx) => Promise<void>>();
  return {
    handlers,
    command(name, handler) {
      handlers.set(name, handler);
    },
  };
}

function groupCtx(text: string): WagerCommandCtx & { replies: string[] } {
  const replies: string[] = [];
  return {
    replies,
    chat: { id: GROUP, type: 'supergroup' },
    from: { id: USER, first_name: 'Nia' },
    match: text,
    async reply(line: string) {
      replies.push(line);
      return undefined;
    },
  };
}

function privateCtx(text: string): WagerCommandCtx & {
  replies: string[];
  replyOptions: Array<Parameters<WagerCommandCtx['reply']>[1]>;
} {
  const replies: string[] = [];
  const replyOptions: Array<Parameters<WagerCommandCtx['reply']>[1]> = [];
  return {
    replies,
    replyOptions,
    chat: { id: USER, type: 'private' },
    from: { id: USER, first_name: 'Nia' },
    match: text,
    async reply(line, options) {
      replies.push(line);
      replyOptions.push(options);
      return undefined;
    },
  };
}

async function invoke(
  bot: FakeCommandBot,
  name: string,
  ctx: WagerCommandCtx,
): Promise<void> {
  const handler = bot.handlers.get(name);
  if (!handler) throw new Error(`command ${name} not registered`);
  await handler(ctx);
}

describe('module surface', () => {
  it('currencyForMint is always sol (SOL-only product)', async () => {
    const { deps } = makeFakeDeps();
    expect(await createWagerModule(deps).currencyForMint(GROUP)).toBe('sol');
  });

  it('reports stake availability from rollout and persisted breaker state', async () => {
    const { deps, db } = makeFakeDeps();
    const module = createWagerModule(deps);
    expect(await module.stakesAvailable()).toBe(true);
    db.status = { paused: true, reason: 'solvency: shortfall' };
    expect(await module.stakesAvailable()).toBe(false);
    expect(await createWagerModule({ ...deps, stakeAcceptanceEnabled: false }).stakesAvailable())
      .toBe(false);
  });

  it('presetLamports maps an index to lamports; out-of-range → null', () => {
    const { deps } = makeFakeDeps();
    const module = createWagerModule(deps);
    expect(module.presetLamports(0)).toBe(WAGER_TUNABLES.PRESET_STAKES_LAMPORTS[0]);
    expect(module.presetLamports(2)).toBe(WAGER_TUNABLES.PRESET_STAKES_LAMPORTS[2]);
    expect(module.presetLamports(9)).toBeNull();
  });

  it('walletSummary returns the user-global balance and linked pubkey', async () => {
    const { deps, db } = makeFakeDeps();
    db.seedLink(USER, VALID_PUBKEY);
    db.seedBalance(USER, 50_000_000n);
    const summary = await createWagerModule(deps).walletSummary(USER);
    expect(summary.balanceLamports).toBe(50_000_000n);
    expect(summary.lockedLamports).toBe(0n);
    expect(summary.pubkey).toBe(VALID_PUBKEY);
  });

  it('walletSummary reports a null pubkey when the user has no wallet', async () => {
    const { deps } = makeFakeDeps();
    const summary = await createWagerModule(deps).walletSummary(USER);
    expect(summary.pubkey).toBeNull();
    expect(summary.balanceLamports).toBe(0n);
    expect(summary.lockedLamports).toBe(0n);
  });

  it('includes only this user open-market positions in the locked balance', async () => {
    const { deps, db } = makeFakeDeps();
    db.openSolMarkets = ['market-open'];
    db.seedPosition({ market_id: 'market-open', user_id: USER, stake: 10_000_000 });
    db.seedPosition({ market_id: 'market-open', user_id: USER + 1, stake: 50_000_000 });
    db.seedPosition({
      market_id: 'market-open',
      user_id: USER,
      stake: 20_000_000,
      state: 'void',
    });
    expect((await createWagerModule(deps).walletSummary(USER)).lockedLamports)
      .toBe(10_000_000n);
  });

  it('presetLabels renders the three presets as exact SOL', () => {
    const { deps } = makeFakeDeps();
    expect(createWagerModule(deps).presetLabels()).toEqual(['0.01 SOL', '0.05 SOL', '0.1 SOL']);
  });

  it('cardFooter is the copy-bank line', () => {
    const { deps } = makeFakeDeps();
    expect(createWagerModule(deps).cardFooter()).toBe(WAGER_COPY.cardFooter());
  });

  it('funded recovery and workers register the four wager loops at their tunable cadences', () => {
    const { deps } = makeFakeDeps();
    const registered: number[] = [];
    const module = createWagerModule(deps);
    const registry: WagerCronRegistry = {
      every(intervalMs) {
        registered.push(intervalMs);
      },
    };
    module.registerSettlementRecovery(registry);
    module.registerFundedWorkers(registry);
    expect(registered.sort((a, b) => a - b)).toEqual(
      [
        WAGER_TUNABLES.OUTBOX_TICK_MS,
        WAGER_TUNABLES.DEPOSIT_POLL_MS,
        WAGER_TUNABLES.SETTLEMENT_SWEEP_MS,
        WAGER_TUNABLES.SOLVENCY_POLL_MS,
      ].sort((a, b) => a - b),
    );
  });
});

describe('mainnet position confirmation', () => {
  const market: WagerMarketRow = {
    id: '0f14d0ab-9605-4a62-a9e4-5ed26688389b',
    group_id: GROUP,
    status: 'open',
    quote_probability: 0.5,
    quote_multiplier: 2,
  };

  it('persists an intent before confirmation and debits exactly once after confirm', async () => {
    const { deps, db } = makeFakeDeps({ solanaNetwork: 'mainnet-beta' });
    db.seedLink(USER, VALID_PUBKEY);
    db.seedBalance(USER, 50_000_000n);
    const wager = createWagerModule(deps);
    const prepared = await wager.prepareStakeConfirmation({
      market,
      userId: USER,
      userName: 'Nia',
      side: 'back',
      lamports: 10_000_000n,
      inPlay: false,
      nowMs: deps.now(),
      callbackId: 'callback-mainnet-confirm',
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error('confirmation fixture was refused');
    expect(db.pendingIntent?.state).toBe('ready');
    expect(db.positions).toHaveLength(0);

    const result = await wager.confirmStakeConfirmation({
      intentId: prepared.intentId,
      market,
      userId: USER,
      userName: 'Nia',
      side: 'back',
      lamports: 10_000_000n,
      inPlay: false,
      nowMs: deps.now(),
    });

    expect(result.placed).toBe(true);
    expect(db.pendingIntent?.state).toBe('consumed');
    expect(db.positions).toHaveLength(1);
    expect(await db.balanceLamports(USER)).toBe(40_000_000n);
  });

  it('cancels without moving SOL', async () => {
    const { deps, db } = makeFakeDeps({ solanaNetwork: 'mainnet-beta' });
    db.seedLink(USER, VALID_PUBKEY);
    db.seedBalance(USER, 50_000_000n);
    const wager = createWagerModule(deps);
    const prepared = await wager.prepareStakeConfirmation({
      market,
      userId: USER,
      userName: 'Nia',
      side: 'doubt',
      lamports: 10_000_000n,
      inPlay: false,
      nowMs: deps.now(),
      callbackId: 'callback-mainnet-cancel',
    });
    if (!prepared.ok) throw new Error('confirmation fixture was refused');
    expect(await wager.cancelStakeConfirmation(USER, prepared.intentId)).toBe(true);
    expect(db.positions).toHaveLength(0);
    expect(await db.balanceLamports(USER)).toBe(50_000_000n);
  });
});

describe('/wallet command', () => {
  it('fails closed for pasted pubkeys without linking or sweeping deposits', async () => {
    const { deps, db } = makeFakeDeps();
    db.seedOrphanDeposit({
      tx_sig: 'early',
      ix_index: 0,
      sender_pubkey: VALID_PUBKEY,
      lamports: 5_000_000n,
    });
    const bot = fakeBot();
    createWagerModule(deps).registerCommands(bot);

    const ctx = privateCtx(VALID_PUBKEY);
    await invoke(bot, 'wallet', ctx);

    expect(db.links.get(USER)).toBeUndefined();
    expect(db.ledgerByKey(WAGER_KEYS.deposit('early', 0))).toBeUndefined();
    expect(ctx.replies).toEqual([WAGER_COPY.walletSetupUnavailable()]);
  });

  it('gives bad input the same fail-closed recovery without touching links', async () => {
    const { deps, db } = makeFakeDeps();
    const bot = fakeBot();
    createWagerModule(deps).registerCommands(bot);
    const ctx = privateCtx('not-a-pubkey');
    await invoke(bot, 'wallet', ctx);
    expect(ctx.replies).toEqual([WAGER_COPY.walletSetupUnavailable()]);
    expect(db.links.size).toBe(0);
  });

  it('does not replace or claim a link when a pasted pubkey is already reserved', async () => {
    const { deps, db } = makeFakeDeps();
    db.seedLink(99, VALID_PUBKEY);
    const bot = fakeBot();
    createWagerModule(deps).registerCommands(bot);
    const ctx = privateCtx(VALID_PUBKEY);
    await invoke(bot, 'wallet', ctx);
    expect(ctx.replies).toEqual([WAGER_COPY.walletSetupUnavailable()]);
    expect(db.links.get(USER)).toBeUndefined();
    expect(db.links.get(99)?.pubkey).toBe(VALID_PUBKEY);
  });

  it('bare /wallet shows the linked status and balance', async () => {
    const { deps, db } = makeFakeDeps();
    db.seedLink(USER, VALID_PUBKEY);
    db.seedBalance(USER, 50_000_000n);
    const bot = fakeBot();
    createWagerModule(deps).registerCommands(bot);
    const ctx = privateCtx('');
    await invoke(bot, 'wallet', ctx);
    expect(ctx.replies[0]).toContain('0.05 SOL');
  });

  it('issues a hashed one-time session and private connect button', async () => {
    const { deps, db } = makeFakeDeps({
      walletMiniappEnabled: true,
      webBaseUrl: 'https://called-it.example',
    });
    const bot = fakeBot();
    createWagerModule(deps).registerCommands(bot);
    const ctx = privateCtx('');

    await invoke(bot, 'wallet', ctx);

    expect(ctx.replies).toEqual([WAGER_COPY.walletSetupReady()]);
    expect(db.walletLinkSessions).toHaveLength(1);
    expect(db.walletLinkSessions[0]?.token_hash_hex).toMatch(/^[0-9a-f]{64}$/);
    const button = ctx.replyOptions[0]?.reply_markup.inline_keyboard[0]?.[0];
    const buttonUrl = button?.url;
    expect(buttonUrl).toMatch(/^https:\/\/called-it\.example\/wallet\/[A-Za-z0-9_-]{43}$/);
    expect(new URL(buttonUrl ?? 'https://invalid.example').search).toBe('');
    expect(new URL(buttonUrl ?? 'https://invalid.example').hash).toBe('');
    expect(button).not.toHaveProperty('web_app');
    expect(button).not.toHaveProperty('login_url');
    expect(button?.text).toBe(
      'Create or manage wallet',
    );
    expect(buttonUrl).not.toContain(db.walletLinkSessions[0]?.token_hash_hex ?? 'missing');
    expect(
      Date.parse(db.walletLinkSessions[0]?.expires_at ?? '') - deps.now(),
    ).toBe(5 * 60_000);
  });

  it('keeps wallet setup in private chat', async () => {
    const { deps } = makeFakeDeps({ walletMiniappEnabled: true });
    const bot = fakeBot();
    createWagerModule(deps).registerCommands(bot);
    const ctx = groupCtx('');
    await invoke(bot, 'wallet', ctx);
    expect(ctx.replies).toEqual([WAGER_COPY.walletPrivateOnly()]);
  });
});

describe('/deposit command', () => {
  it('names the treasury and warns devnet-only', async () => {
    const { deps, db, chain } = makeFakeDeps();
    db.seedLink(USER, VALID_PUBKEY);
    const bot = fakeBot();
    createWagerModule(deps).registerCommands(bot);
    const ctx = groupCtx('');
    await invoke(bot, 'deposit', ctx);
    expect(ctx.replies[0]).toContain(chain.treasuryPubkey());
    expect(ctx.replies[0]).toContain('DEVNET ONLY');
    expect(db.links.get(USER)?.last_wager_group_id).toBe(GROUP);
  });
});

describe('/withdraw command', () => {
  it('logs a requested withdrawal without Telegram user identity', async () => {
    // Given a funded linked Telegram user and a collectable structured logger
    const infoEvents: Array<{
      readonly event: string;
      readonly fields: Record<string, unknown> | undefined;
    }> = [];
    const { deps, db } = makeFakeDeps({
      log: {
        info(event, fields) {
          infoEvents.push({ event, fields });
        },
        warn: () => undefined,
        error: () => undefined,
      },
    });
    db.seedLink(USER, VALID_PUBKEY);
    db.seedBalance(USER, 1_000_000_000n);
    const bot = fakeBot();
    createWagerModule(deps).registerCommands(bot);

    // When the withdrawal is requested
    await invoke(bot, 'withdraw', groupCtx('0.05'));

    // Then the request log retains domain diagnostics without Telegram identity
    expect(infoEvents.find(({ event }) => event === 'wager_withdrawal_requested')?.fields).toEqual({
      withdrawalId: expect.any(String),
      lamports: '50000000',
    });
  });

  it('queues a valid amount through the RPC and confirms', async () => {
    const { deps, db } = makeFakeDeps();
    db.seedLink(USER, VALID_PUBKEY);
    db.seedBalance(USER, 1_000_000_000n);
    const bot = fakeBot();
    createWagerModule(deps).registerCommands(bot);

    const ctx = groupCtx('0.05');
    await invoke(bot, 'withdraw', ctx);

    expect(ctx.replies[0]).toBe(WAGER_COPY.withdrawQueued(50_000_000n));
    const rows = await db.withdrawalsInState('debited');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lamports).toBe(50_000_000n);
    expect(rows[0]?.dest_pubkey).toBe(VALID_PUBKEY); // resolved from the link, never typed
    expect(await db.balanceLamports(USER)).toBe(950_000_000n); // debited up front
  });

  it('"all" cashes out the full stack', async () => {
    const { deps, db } = makeFakeDeps();
    db.seedLink(USER, VALID_PUBKEY);
    db.seedBalance(USER, 40_000_000n);
    const bot = fakeBot();
    createWagerModule(deps).registerCommands(bot);
    await invoke(bot, 'withdraw', groupCtx('all'));
    expect(await db.balanceLamports(USER)).toBe(0n);
  });

  it('refuses below the minimum', async () => {
    const { deps, db } = makeFakeDeps();
    db.seedLink(USER, VALID_PUBKEY);
    db.seedBalance(USER, 1_000_000_000n);
    const bot = fakeBot();
    createWagerModule(deps).registerCommands(bot);
    const ctx = groupCtx('0.001');
    await invoke(bot, 'withdraw', ctx);
    expect(ctx.replies).toEqual([WAGER_COPY.withdrawBelowMin()]);
    expect(await db.withdrawalsInState('debited')).toHaveLength(0);
  });

  it('requires a linked wallet first', async () => {
    const { deps } = makeFakeDeps();
    const bot = fakeBot();
    createWagerModule(deps).registerCommands(bot);
    const ctx = groupCtx('0.05');
    await invoke(bot, 'withdraw', ctx);
    expect(ctx.replies).toEqual([WAGER_COPY.withdrawNoWallet()]);
  });

  it('maps an insufficient balance to honest copy', async () => {
    const { deps, db } = makeFakeDeps();
    db.seedLink(USER, VALID_PUBKEY);
    db.seedBalance(USER, WAGER_TUNABLES.MIN_WITHDRAWAL_LAMPORTS);
    const bot = fakeBot();
    createWagerModule(deps).registerCommands(bot);
    const ctx = groupCtx('1');
    await invoke(bot, 'withdraw', ctx);
    expect(ctx.replies[0]).toBe(
      WAGER_COPY.withdrawInsufficient(WAGER_TUNABLES.MIN_WITHDRAWAL_LAMPORTS),
    );
  });
});
