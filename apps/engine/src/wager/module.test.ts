import { describe, expect, it } from 'vitest';
import { base58Encode } from '@calledit/solana';
import { createWagerModule } from './module.js';
import { WAGER_COPY } from './copy.js';
import { WAGER_KEYS, WAGER_TUNABLES } from './constants.js';
import { makeFakeDeps } from './fakes.js';
import type { WagerCommandCtx } from './port.js';

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
    expect(summary.pubkey).toBe(VALID_PUBKEY);
  });

  it('walletSummary reports a null pubkey when the user has no wallet', async () => {
    const { deps } = makeFakeDeps();
    const summary = await createWagerModule(deps).walletSummary(USER);
    expect(summary.pubkey).toBeNull();
    expect(summary.balanceLamports).toBe(0n);
  });

  it('presetLabels renders the three presets as exact SOL', () => {
    const { deps } = makeFakeDeps();
    expect(createWagerModule(deps).presetLabels()).toEqual(['0.01 SOL', '0.05 SOL', '0.1 SOL']);
  });

  it('cardFooter is the copy-bank line', () => {
    const { deps } = makeFakeDeps();
    expect(createWagerModule(deps).cardFooter()).toBe(WAGER_COPY.cardFooter());
  });

  it('registerCrons registers the four wager loops at their tunable cadences', () => {
    const { deps } = makeFakeDeps();
    const registered: number[] = [];
    createWagerModule(deps).registerCrons({
      every(intervalMs) {
        registered.push(intervalMs);
      },
    });
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

describe('/wallet command', () => {
  it('links a valid pubkey, remembers the group, and sweeps orphan deposits', async () => {
    const { deps, db } = makeFakeDeps();
    db.seedOrphanDeposit({
      tx_sig: 'early',
      ix_index: 0,
      sender_pubkey: VALID_PUBKEY,
      lamports: 5_000_000n,
    });
    const bot = fakeBot();
    createWagerModule(deps).registerCommands(bot);

    const ctx = groupCtx(VALID_PUBKEY);
    await invoke(bot, 'wallet', ctx);

    expect(db.links.get(USER)?.pubkey).toBe(VALID_PUBKEY);
    expect(db.links.get(USER)?.last_wager_group_id).toBe(GROUP);
    expect(db.ledgerByKey(WAGER_KEYS.deposit('early', 0))?.lamports).toBe(5_000_000n);
    expect(ctx.replies[0]).toContain('0.005 SOL'); // swept credit is named
  });

  it('rejects garbage addresses without touching the link table', async () => {
    const { deps, db } = makeFakeDeps();
    const bot = fakeBot();
    createWagerModule(deps).registerCommands(bot);
    const ctx = groupCtx('not-a-pubkey');
    await invoke(bot, 'wallet', ctx);
    expect(ctx.replies).toEqual([WAGER_COPY.walletInvalid()]);
    expect(db.links.size).toBe(0);
  });

  it('first link wins — a second user cannot claim the same pubkey', async () => {
    const { deps, db } = makeFakeDeps();
    db.seedLink(99, VALID_PUBKEY);
    const bot = fakeBot();
    createWagerModule(deps).registerCommands(bot);
    const ctx = groupCtx(VALID_PUBKEY);
    await invoke(bot, 'wallet', ctx);
    expect(ctx.replies).toEqual([WAGER_COPY.walletPubkeyTaken()]);
    expect(db.links.get(USER)).toBeUndefined();
  });

  it('bare /wallet shows the linked status and balance', async () => {
    const { deps, db } = makeFakeDeps();
    db.seedLink(USER, VALID_PUBKEY);
    db.seedBalance(USER, 50_000_000n);
    const bot = fakeBot();
    createWagerModule(deps).registerCommands(bot);
    const ctx = groupCtx('');
    await invoke(bot, 'wallet', ctx);
    expect(ctx.replies[0]).toContain('0.05 SOL');
  });
});

describe('/deposit command', () => {
  it('names the treasury and warns about mainnet sends', async () => {
    const { deps, db, chain } = makeFakeDeps();
    db.seedLink(USER, VALID_PUBKEY);
    const bot = fakeBot();
    createWagerModule(deps).registerCommands(bot);
    const ctx = groupCtx('');
    await invoke(bot, 'deposit', ctx);
    expect(ctx.replies[0]).toContain(chain.treasuryPubkey());
    expect(ctx.replies[0]).toContain('Test tokens only');
    expect(db.links.get(USER)?.last_wager_group_id).toBe(GROUP);
  });
});

describe('/withdraw command', () => {
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
