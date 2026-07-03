/**
 * Hermetic in-memory fakes for the wager ports — no network, no Supabase.
 * A shared `trace` array records money-relevant operations in call order so
 * tests can assert sequencing invariants (e.g. persist-before-broadcast).
 */

import type {
  WagerBlockheightCheck,
  WagerBuiltTransfer,
  WagerChain,
  WagerDb,
  WagerDepositRow,
  WagerDepositScan,
  WagerIncomingTransfer,
  WagerLedgerEntry,
  WagerLogger,
  WagerModuleDeps,
  WagerPositionRow,
  WagerPoster,
  WagerSettlementOutcome,
  WagerSigStatus,
  WagerStakeResult,
  WagerWalletLinkRow,
  WagerWithdrawalRow,
  WagerWithdrawResult,
} from './port.js';

export const silentLog: WagerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface CollectedPost {
  chatId: number;
  text: string;
}

export function collectingPoster(): WagerPoster & { posts: CollectedPost[] } {
  const posts: CollectedPost[] = [];
  return {
    posts,
    post(chatId, text) {
      posts.push({ chatId, text });
    },
  };
}

let nextId = 0;
function freshId(prefix: string): string {
  nextId += 1;
  return `${prefix}-${nextId}`;
}

export class FakeWagerDb implements WagerDb {
  readonly trace: string[];
  readonly ledger: WagerLedgerEntry[] = [];
  private readonly ledgerKeys = new Set<string>();
  readonly links = new Map<number, WagerWalletLinkRow>();
  readonly deposits = new Map<string, WagerDepositRow>();
  readonly withdrawals = new Map<string, WagerWithdrawalRow>();
  readonly positions: WagerPositionRow[] = [];
  readonly settlements = new Map<string, WagerSettlementOutcome>();
  readonly applied = new Set<string>();
  readonly groupsEnabled = new Map<number, boolean>();
  readonly cursors = new Map<string, string>();
  readonly users = new Map<number, string>();
  status: { paused: boolean; reason: string | null } = { paused: false, reason: null };
  openSolMarkets: string[] = [];
  cronLockGranted = true;
  /** When set, wagerStake returns this instead of the default happy path. */
  stakeResult: WagerStakeResult | null = null;
  lastStakeArgs: Parameters<WagerDb['wagerStake']>[0] | null = null;

  constructor(trace: string[] = []) {
    this.trace = trace;
  }

  async setGroupEnabled(groupId: number, enabled: boolean): Promise<void> {
    this.groupsEnabled.set(groupId, enabled);
  }

  async isGroupEnabled(groupId: number): Promise<boolean> {
    return this.groupsEnabled.get(groupId) ?? false;
  }

  async getWalletLink(userId: number): Promise<WagerWalletLinkRow | null> {
    return this.links.get(userId) ?? null;
  }

  async getWalletLinkByPubkey(pubkey: string): Promise<WagerWalletLinkRow | null> {
    for (const link of this.links.values()) {
      if (link.pubkey === pubkey) return link;
    }
    return null;
  }

  async linkWallet(input: { user_id: number; pubkey: string }): Promise<
    { ok: true; relinked: boolean } | { ok: false; reason: 'pubkey_taken' }
  > {
    const holder = await this.getWalletLinkByPubkey(input.pubkey);
    if (holder && holder.user_id !== input.user_id) return { ok: false, reason: 'pubkey_taken' };
    const existing = this.links.get(input.user_id);
    this.links.set(input.user_id, {
      user_id: input.user_id,
      pubkey: input.pubkey,
      last_wager_group_id: existing?.last_wager_group_id ?? null,
      verified_at: null,
      created_at: new Date(0).toISOString(),
    });
    return { ok: true, relinked: existing !== undefined && existing.pubkey !== input.pubkey };
  }

  async setLastWagerGroup(userId: number, groupId: number): Promise<void> {
    const link = this.links.get(userId);
    if (link) link.last_wager_group_id = groupId;
  }

  async balanceLamports(userId: number): Promise<bigint> {
    return this.ledger
      .filter((entry) => entry.user_id === userId)
      .reduce((sum, entry) => sum + entry.lamports, 0n);
  }

  async totalLedgerLamports(): Promise<bigint> {
    return this.ledger.reduce((sum, entry) => sum + entry.lamports, 0n);
  }

  async postWagerLedger(entry: WagerLedgerEntry): Promise<{ inserted: boolean }> {
    this.trace.push(`db.postWagerLedger:${entry.idempotency_key}`);
    if (this.ledgerKeys.has(entry.idempotency_key)) return { inserted: false };
    this.ledgerKeys.add(entry.idempotency_key);
    this.ledger.push(entry);
    return { inserted: true };
  }

  async wagerStake(
    args: Parameters<WagerDb['wagerStake']>[0],
  ): Promise<WagerStakeResult> {
    this.lastStakeArgs = args;
    this.trace.push(`db.wagerStake:${args.market_id}`);
    if (this.stakeResult) return this.stakeResult;
    if (this.status.paused) return { ok: false, code: 'paused' };
    const balance = await this.balanceLamports(args.user_id);
    if (balance < args.lamports) return { ok: false, code: 'insufficient' };
    const positionId = freshId('pos');
    this.positions.push({
      id: positionId,
      market_id: args.market_id,
      user_id: args.user_id,
      side: args.side,
      stake: Number(args.lamports),
      locked_multiplier: args.multiplier,
      state: args.state,
      placed_at_ms: args.placed_at_ms,
    });
    await this.postWagerLedger({
      user_id: args.user_id,
      group_id: args.group_id,
      market_id: args.market_id,
      kind: 'stake',
      lamports: -args.lamports,
      idempotency_key: `wager:stake:${positionId}`,
    });
    return { ok: true, position_id: positionId };
  }

  async requestWithdrawal(args: {
    user_id: number;
    lamports: bigint;
  }): Promise<WagerWithdrawResult> {
    const link = this.links.get(args.user_id);
    if (!link) return { ok: false, code: 'no_wallet' };
    const balance = await this.balanceLamports(args.user_id);
    if (balance < args.lamports) return { ok: false, code: 'insufficient' };
    const id = freshId('wd');
    this.withdrawals.set(id, {
      id,
      user_id: args.user_id,
      dest_pubkey: link.pubkey,
      lamports: args.lamports,
      state: 'debited',
      tx_sig: null,
      raw_tx_b64: null,
      last_valid_block_height: null,
      error: null,
    });
    await this.postWagerLedger({
      user_id: args.user_id,
      group_id: null,
      market_id: null,
      kind: 'withdrawal',
      lamports: -args.lamports,
      idempotency_key: `wager:withdrawal:${id}`,
    });
    return { ok: true, withdrawal_id: id };
  }

  private depositKey(txSig: string, ixIndex: number): string {
    return `${txSig}:${ixIndex}`;
  }

  async upsertDeposit(row: {
    tx_sig: string;
    ix_index: number;
    sender_pubkey: string;
    lamports: bigint;
    slot: number;
  }): Promise<{ inserted: boolean }> {
    const key = this.depositKey(row.tx_sig, row.ix_index);
    if (this.deposits.has(key)) return { inserted: false };
    this.deposits.set(key, { ...row, user_id: null, credited_at: null });
    return { inserted: true };
  }

  async markDepositCredited(txSig: string, ixIndex: number, userId: number): Promise<void> {
    const row = this.deposits.get(this.depositKey(txSig, ixIndex));
    if (!row) return;
    row.user_id = userId;
    row.credited_at = new Date(0).toISOString();
  }

  async orphanDepositsBySender(pubkey: string): Promise<WagerDepositRow[]> {
    return [...this.deposits.values()].filter(
      (row) => row.sender_pubkey === pubkey && row.user_id === null,
    );
  }

  async withdrawalsInState(state: 'debited' | 'submitted'): Promise<WagerWithdrawalRow[]> {
    return [...this.withdrawals.values()].filter((row) => row.state === state);
  }

  async markWithdrawalSubmitted(
    id: string,
    tx: { tx_sig: string; raw_tx_b64: string; last_valid_block_height: number },
  ): Promise<void> {
    this.trace.push(`db.markWithdrawalSubmitted:${tx.tx_sig}`);
    const row = this.withdrawals.get(id);
    if (!row) throw new Error(`unknown withdrawal ${id}`);
    row.state = 'submitted';
    row.tx_sig = tx.tx_sig;
    row.raw_tx_b64 = tx.raw_tx_b64;
    row.last_valid_block_height = tx.last_valid_block_height;
  }

  async markWithdrawalConfirmed(id: string): Promise<void> {
    this.trace.push(`db.markWithdrawalConfirmed:${id}`);
    const row = this.withdrawals.get(id);
    if (!row) throw new Error(`unknown withdrawal ${id}`);
    row.state = 'confirmed';
  }

  async markWithdrawalFailed(id: string, error: string): Promise<void> {
    this.trace.push(`db.markWithdrawalFailed:${id}`);
    const row = this.withdrawals.get(id);
    if (!row) throw new Error(`unknown withdrawal ${id}`);
    row.state = 'failed';
    row.error = error;
  }

  async positionsForMarket(marketId: string): Promise<WagerPositionRow[]> {
    return this.positions.filter((position) => position.market_id === marketId);
  }

  async setPositionStates(ids: string[], state: 'pending' | 'active' | 'void'): Promise<void> {
    for (const position of this.positions) {
      if (ids.includes(position.id)) position.state = state;
    }
  }

  async getSettlementOutcome(marketId: string): Promise<WagerSettlementOutcome | null> {
    return this.settlements.get(marketId) ?? null;
  }

  async hasSettlementApplied(marketId: string): Promise<boolean> {
    return this.applied.has(marketId);
  }

  async insertSettlementApplied(marketId: string): Promise<void> {
    this.applied.add(marketId);
  }

  async settledSolMarketsMissingApplied(): Promise<string[]> {
    return [...this.settlements.keys()].filter((marketId) => !this.applied.has(marketId));
  }

  async openSolMarketIds(): Promise<string[]> {
    return this.openSolMarkets;
  }

  async getWagerStatus(): Promise<{ paused: boolean; reason: string | null }> {
    return this.status;
  }

  async setWagerStatus(paused: boolean, reason: string | null): Promise<void> {
    this.status = { paused, reason };
  }

  async getCursor(streamName: string): Promise<string | null> {
    return this.cursors.get(streamName) ?? null;
  }

  async setCursor(streamName: string, value: string): Promise<void> {
    this.cursors.set(streamName, value);
  }

  async tryCronLock(): Promise<boolean> {
    return this.cronLockGranted;
  }

  async releaseCronLock(): Promise<void> {
    // nothing to release in-memory
  }

  async getUserName(userId: number): Promise<string | null> {
    return this.users.get(userId) ?? null;
  }

  // ── test helpers ─────────────────────────────────────────────────────────

  seedLink(userId: number, pubkey: string, lastGroupId: number | null = null): void {
    this.links.set(userId, {
      user_id: userId,
      pubkey,
      last_wager_group_id: lastGroupId,
      verified_at: null,
      created_at: new Date(0).toISOString(),
    });
  }

  seedBalance(userId: number, lamports: bigint, key = `seed:${userId}`): void {
    this.ledgerKeys.add(key);
    this.ledger.push({
      user_id: userId,
      group_id: null,
      market_id: null,
      kind: 'deposit',
      lamports,
      idempotency_key: key,
    });
  }

  seedPosition(position: Partial<WagerPositionRow> & { market_id: string }): WagerPositionRow {
    const row: WagerPositionRow = {
      id: position.id ?? freshId('pos'),
      market_id: position.market_id,
      user_id: position.user_id ?? 1,
      side: position.side ?? 'back',
      stake: position.stake ?? 10_000_000,
      locked_multiplier: position.locked_multiplier ?? 2,
      state: position.state ?? 'active',
      placed_at_ms: position.placed_at_ms ?? 0,
    };
    this.positions.push(row);
    return row;
  }

  seedOrphanDeposit(row: {
    tx_sig: string;
    ix_index: number;
    sender_pubkey: string;
    lamports: bigint;
    slot?: number;
  }): void {
    this.deposits.set(this.depositKey(row.tx_sig, row.ix_index), {
      tx_sig: row.tx_sig,
      ix_index: row.ix_index,
      sender_pubkey: row.sender_pubkey,
      lamports: row.lamports,
      slot: row.slot ?? 1,
      user_id: null,
      credited_at: null,
    });
  }

  ledgerByKey(key: string): WagerLedgerEntry | undefined {
    return this.ledger.find((entry) => entry.idempotency_key === key);
  }
}

export class FakeWagerChain implements WagerChain {
  readonly trace: string[];
  treasury = 'TreasuryPubkey1111111111111111111111111111';
  treasuryLamports = 10_000_000_000n;
  treasuryBalanceFails = false;
  scan: WagerDepositScan = { ok: true, transfers: [], newestSig: null };
  buildFails: { error: string; permanent?: boolean } | null = null;
  broadcastFails = false;
  readonly broadcasts: string[] = [];
  readonly airdrops: bigint[] = [];
  airdropFails = false;
  sigStatuses = new Map<string, WagerSigStatus>();
  blockheightExceeded = false;
  private buildCount = 0;

  constructor(trace: string[] = []) {
    this.trace = trace;
  }

  treasuryPubkey(): string {
    return this.treasury;
  }

  async treasuryBalanceLamports(): Promise<
    { ok: true; lamports: bigint } | { ok: false; error: string }
  > {
    if (this.treasuryBalanceFails) return { ok: false, error: 'rpc down' };
    return { ok: true, lamports: this.treasuryLamports };
  }

  async buildTransfer(args: { to: string; lamports: bigint }): Promise<WagerBuiltTransfer> {
    this.trace.push(`chain.buildTransfer:${args.to}`);
    if (this.buildFails) return { ok: false, ...this.buildFails };
    this.buildCount += 1;
    return {
      ok: true,
      sig: `sig-${this.buildCount}`,
      rawTxB64: `raw-${this.buildCount}`,
      lastValidBlockHeight: 100 + this.buildCount,
    };
  }

  async broadcastRawTx(rawTxB64: string): Promise<{ ok: true } | { ok: false; error: string }> {
    this.trace.push(`chain.broadcastRawTx:${rawTxB64}`);
    if (this.broadcastFails) return { ok: false, error: 'send failed' };
    this.broadcasts.push(rawTxB64);
    return { ok: true };
  }

  async getSigStatus(sig: string): Promise<WagerSigStatus> {
    return this.sigStatuses.get(sig) ?? { ok: true, found: false };
  }

  // Property (not method) so tests can swap in failure responses per-case.
  isBlockheightExceeded: () => Promise<WagerBlockheightCheck> = async () => ({
    ok: true,
    exceeded: this.blockheightExceeded,
  });

  async fetchIncomingTransfers(): Promise<WagerDepositScan> {
    return this.scan;
  }

  async requestAirdrop(
    lamports: bigint,
  ): Promise<{ ok: true; sig: string } | { ok: false; error: string }> {
    if (this.airdropFails) return { ok: false, error: 'faucet rate limit' };
    this.airdrops.push(lamports);
    return { ok: true, sig: 'airdrop-sig' };
  }

  setScanTransfers(transfers: WagerIncomingTransfer[]): void {
    const last = transfers[transfers.length - 1];
    this.scan = { ok: true, transfers, newestSig: last?.sig ?? null };
  }
}

export interface FakeDepsBundle {
  deps: WagerModuleDeps;
  db: FakeWagerDb;
  chain: FakeWagerChain;
  poster: ReturnType<typeof collectingPoster>;
  trace: string[];
}

export function makeFakeDeps(overrides: Partial<WagerModuleDeps> = {}): FakeDepsBundle {
  const trace: string[] = [];
  const db = new FakeWagerDb(trace);
  const chain = new FakeWagerChain(trace);
  const poster = collectingPoster();
  const deps: WagerModuleDeps = {
    db,
    chain,
    poster,
    log: silentLog,
    now: () => 1_720_000_000_000,
    opsChatId: null,
    ...overrides,
  };
  return { deps, db, chain, poster, trace };
}
