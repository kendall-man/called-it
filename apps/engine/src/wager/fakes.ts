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
  WagerDepositCreditResult,
  WagerDepositScan,
  WagerIncomingTransfer,
  WagerLedgerEntry,
  WagerLogger,
  WagerLegacyReconciliationSummary,
  WagerModuleDeps,
  PendingStakeIntentRow,
  WagerPositionRow,
  WagerPoster,
  WagerSettlementOutcome,
  WagerSigStatus,
  WagerStakeResult,
  WagerSolvencySnapshot,
  WagerWalletLinkRow,
  WagerWithdrawalRow,
  WagerWithdrawResult,
  WalletLinkChallengeInput,
  VerifiedWalletLinkResult,
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
  private readonly walletHistory = new Map<string, number>();
  readonly deposits = new Map<string, WagerDepositRow>();
  readonly withdrawals = new Map<string, WagerWithdrawalRow>();
  readonly positions: WagerPositionRow[] = [];
  readonly settlements = new Map<string, WagerSettlementOutcome>();
  readonly marketProbabilities = new Map<string, number>();
  readonly applied = new Set<string>();
  readonly groupsEnabled = new Map<number, boolean>();
  readonly cursors = new Map<string, string>();
  readonly users = new Map<number, string>();
  readonly pendingStakeIntents = new Map<string, PendingStakeIntentRow>();
  private readonly intentIdsByHash = new Map<string, string>();
  private readonly walletChallenges = new Map<string, WalletLinkChallengeInput>();
  private readonly consumedWalletChallenges = new Set<string>();
  status: { paused: boolean; reason: string | null } = { paused: false, reason: null };
  openSolMarkets: string[] = [];
  starterBudget = {
    enabled: false,
    totalCapLamports: 5_000_000_000n,
    grantedLamports: 0n,
  };
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

  async setLastWagerGroup(userId: number, groupId: number): Promise<void> {
    const link = this.links.get(userId);
    if (link) link.last_wager_group_id = groupId;
  }

  async createWalletLinkChallenge(args: WalletLinkChallengeInput): Promise<void> {
    this.walletChallenges.set(args.id, args);
  }

  async verifyWalletLink(
    args: Parameters<WagerDb['verifyWalletLink']>[0],
  ): Promise<VerifiedWalletLinkResult> {
    const challenge = this.walletChallenges.get(args.challenge_id);
    if (
      challenge === undefined ||
      this.consumedWalletChallenges.has(args.challenge_id) ||
      challenge.user_id !== args.user_id ||
      challenge.pubkey !== args.pubkey ||
      challenge.challenge_hash_hex !== args.challenge_hash_hex
    ) {
      return { ok: false as const, code: 'challenge_invalid' as const };
    }
    this.consumedWalletChallenges.add(args.challenge_id);
    const reservedUser = this.walletHistory.get(args.pubkey);
    if (reservedUser !== undefined && reservedUser !== args.user_id) {
      return { ok: false as const, code: 'pubkey_reserved' as const };
    }
    const current = this.links.get(args.user_id);
    if (current !== undefined && current.pubkey !== args.pubkey) {
      if ((await this.balanceLamports(args.user_id)) !== 0n) {
        return { ok: false as const, code: 'balance_nonzero' as const };
      }
      if (this.positions.some((position) => position.user_id === args.user_id && position.state !== 'void')) {
        return { ok: false as const, code: 'positions_open' as const };
      }
      if (
        [...this.withdrawals.values()].some(
          (withdrawal) =>
            withdrawal.user_id === args.user_id &&
            (withdrawal.state === 'debited' || withdrawal.state === 'submitted'),
        )
      ) {
        return { ok: false as const, code: 'withdrawal_pending' as const };
      }
    }
    this.walletHistory.set(args.pubkey, args.user_id);
    this.links.set(args.user_id, {
      user_id: args.user_id,
      pubkey: args.pubkey,
      last_wager_group_id: null,
      verified_at: new Date(0).toISOString(),
      created_at: new Date(0).toISOString(),
    });
    return { ok: true as const, relinked: current !== undefined && current.pubkey !== args.pubkey, link_id: 1 };
  }

  async createPendingStakeIntent(args: Parameters<WagerDb['createPendingStakeIntent']>[0]) {
    const existingId = this.intentIdsByHash.get(args.intent_key_hash_hex);
    if (existingId !== undefined) {
      const existing = this.pendingStakeIntents.get(existingId);
      if (existing === undefined) throw new Error('missing fake stake intent');
      const sameFields =
        existing.user_id === args.user_id &&
        existing.group_id === args.group_id &&
        existing.market_id === args.market_id &&
        existing.side === args.side &&
        existing.lamports === args.lamports;
      return sameFields
        ? { ok: true as const, intent_id: existing.id, state: existing.state }
        : { ok: false as const, code: 'field_mismatch' as const };
    }
    const active = [...this.pendingStakeIntents.values()].find(
      (intent) => intent.user_id === args.user_id &&
        (intent.state === 'pending' || intent.state === 'awaiting_funds' || intent.state === 'ready'),
    );
    if (active !== undefined) {
      return { ok: false as const, code: 'active_intent_exists' as const, intent_id: active.id };
    }
    const id = `00000000-0000-4000-8000-${String(this.pendingStakeIntents.size + 1).padStart(12, '0')}`;
    const now = new Date(0).toISOString();
    const intent: PendingStakeIntentRow = {
      id,
      user_id: args.user_id,
      group_id: args.group_id,
      market_id: args.market_id,
      side: args.side,
      lamports: args.lamports,
      state: 'pending',
      expires_at: args.expires_at,
      created_at: now,
      updated_at: now,
    };
    this.pendingStakeIntents.set(id, intent);
    this.intentIdsByHash.set(args.intent_key_hash_hex, id);
    return { ok: true as const, intent_id: id, state: intent.state };
  }

  async resolveActiveStakeIntent(userId: number) {
    const intent = [...this.pendingStakeIntents.values()].find(
      (candidate) => candidate.user_id === userId &&
        (candidate.state === 'pending' || candidate.state === 'awaiting_funds' || candidate.state === 'ready'),
    );
    return intent === undefined
      ? { ok: false as const, code: 'not_found' as const }
      : { ok: true as const, intent };
  }

  async getPendingStakeIntent(userId: number, intentId: string) {
    const intent = this.pendingStakeIntents.get(intentId);
    return intent === undefined || intent.user_id !== userId
      ? { ok: false as const, code: 'not_found' as const }
      : { ok: true as const, intent };
  }

  async markStakeIntentFunded(userId: number, intentId: string) {
    const intent = this.pendingStakeIntents.get(intentId);
    if (intent === undefined || intent.user_id !== userId || (intent.state !== 'pending' && intent.state !== 'awaiting_funds')) {
      return { ok: false as const, code: 'not_ready' as const };
    }
    intent.state = 'ready';
    return { ok: true as const };
  }

  async consumeReadyStakeIntent(userId: number, intentId: string) {
    const intent = this.pendingStakeIntents.get(intentId);
    if (intent === undefined || intent.user_id !== userId || intent.state !== 'ready') {
      return { ok: false as const, code: 'not_ready' as const };
    }
    intent.state = 'consumed';
    return { ok: true as const, intent };
  }

  async cancelStakeIntent(userId: number, intentId: string) {
    const intent = this.pendingStakeIntents.get(intentId);
    if (intent === undefined || intent.user_id !== userId || (intent.state !== 'pending' && intent.state !== 'awaiting_funds' && intent.state !== 'ready')) {
      return { ok: false as const, code: 'not_found' as const };
    }
    intent.state = 'cancelled';
    return { ok: true as const };
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
    // At-least-once dedup: a prior stake with the same client key already landed.
    const ledgerKey =
      args.idempotency_key !== undefined
        ? `wager:stake:api:${args.idempotency_key}`
        : undefined;
    if (ledgerKey !== undefined && this.ledgerKeys.has(ledgerKey)) {
      return { ok: true, duplicate: true };
    }
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
      idempotency_key: ledgerKey ?? `wager:stake:${positionId}`,
    });
    return { ok: true, position_id: positionId };
  }

  async requestWithdrawal(args: {
    user_id: number;
    lamports: bigint;
  }): Promise<WagerWithdrawResult> {
    const link = this.links.get(args.user_id);
    if (!link) return { ok: false, code: 'no_wallet' };
    if (link.verified_at === null) return { ok: false, code: 'wallet_unverified' };
    if (
      [...this.withdrawals.values()].some(
        (withdrawal) =>
          withdrawal.user_id === args.user_id &&
          (withdrawal.state === 'debited' || withdrawal.state === 'submitted'),
      )
    ) {
      return { ok: false, code: 'withdrawal_pending' };
    }
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
    this.deposits.set(key, {
      ...row,
      user_id: null,
      credited_at: null,
      attribution_state: 'unattributed',
      attribution_reason: null,
    });
    return { inserted: true };
  }

  async creditDepositToCurrentVerifiedWallet(args: {
    tx_sig: string;
    ix_index: number;
    min_lamports: bigint;
  }): Promise<WagerDepositCreditResult> {
    const row = this.deposits.get(this.depositKey(args.tx_sig, args.ix_index));
    if (!row) return { ok: false, code: 'not_found' };
    if (row.attribution_state === 'credited') {
      if (row.user_id === null) throw new Error('credited fake deposit has no owner');
      return { ok: true, outcome: 'already_credited', user_id: row.user_id };
    }
    if (row.attribution_state === 'orphaned') {
      return { ok: false, code: row.attribution_reason ?? 'legacy_orphan' };
    }
    if (row.attribution_state === 'dust') return { ok: false, code: 'below_minimum' };
    if (row.lamports < args.min_lamports) {
      row.attribution_state = 'dust';
      row.attribution_reason = 'below_minimum';
      return { ok: false, code: 'below_minimum' };
    }

    const link = await this.getWalletLinkByPubkey(row.sender_pubkey);
    if (link === null || link.verified_at === null) {
      const code =
        link !== null
          ? 'unverified_wallet'
          : this.walletHistory.has(row.sender_pubkey)
            ? 'stale_wallet'
            : 'unlinked_sender';
      row.attribution_state = 'orphaned';
      row.attribution_reason = code;
      return { ok: false, code };
    }

    const posted = await this.postWagerLedger({
      user_id: link.user_id,
      group_id: null,
      market_id: null,
      kind: 'deposit',
      lamports: row.lamports,
      idempotency_key: `wager:deposit:${row.tx_sig}:${row.ix_index}`,
    });
    row.user_id = link.user_id;
    row.credited_at = new Date(0).toISOString();
    row.attribution_state = 'credited';
    row.attribution_reason = null;
    return {
      ok: true,
      outcome: posted.inserted ? 'credited' : 'already_credited',
      user_id: link.user_id,
    };
  }

  async orphanDepositsBySender(pubkey: string): Promise<WagerDepositRow[]> {
    return [...this.deposits.values()].filter(
      (row) => row.sender_pubkey === pubkey && row.user_id === null,
    );
  }

  async classifyLegacyWalletReconciliation(): Promise<WagerLegacyReconciliationSummary> {
    const reasons = new Map<string, number>();
    for (const deposit of this.deposits.values()) {
      if (deposit.attribution_state !== 'orphaned') continue;
      const reason = deposit.attribution_reason ?? 'legacy_orphan';
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    const orphanDepositCount = [...reasons.values()].reduce((sum, count) => sum + count, 0);
    return {
      unresolved_count: orphanDepositCount,
      unverified_link_count: 0,
      orphan_deposit_count: orphanDepositCount,
      reasons: [...reasons.entries()].map(([reason, count]) => ({
        kind: 'orphan_deposit',
        reason,
        count,
      })),
    };
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

  async getMarketProbability(marketId: string): Promise<number | null> {
    return this.marketProbabilities.get(marketId) ?? null;
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

  async setSolvencyStatus(paused: boolean, reason: string | null): Promise<void> {
    const isManualPause =
      this.status.paused && this.status.reason !== null && !this.status.reason.startsWith('solvency:');
    if (isManualPause) return;
    if (!paused && !this.status.paused) return;
    if (!paused && (this.status.reason === null || !this.status.reason.startsWith('solvency:'))) return;
    this.status = { paused, reason };
  }

  async getSolvencySnapshot(): Promise<WagerSolvencySnapshot> {
    const balances = new Map<number, bigint>();
    for (const entry of this.ledger) {
      balances.set(entry.user_id, (balances.get(entry.user_id) ?? 0n) + entry.lamports);
    }
    let positiveLedgerLamports = 0n;
    for (const balance of balances.values()) {
      if (balance > 0n) positiveLedgerLamports += balance;
    }
    let openEscrowLamports = 0n;
    for (const position of this.positions) {
      if (position.state === 'void' || !this.openSolMarkets.includes(position.market_id)) continue;
      openEscrowLamports += BigInt(position.stake);
    }
    let pendingWithdrawalLamports = 0n;
    for (const withdrawal of this.withdrawals.values()) {
      if (withdrawal.state === 'debited' || withdrawal.state === 'submitted') {
        pendingWithdrawalLamports += withdrawal.lamports;
      }
    }
    return {
      positive_ledger_lamports: positiveLedgerLamports,
      open_escrow_lamports: openEscrowLamports,
      pending_withdrawal_lamports: pendingWithdrawalLamports,
      remaining_starter_cap_lamports: this.starterBudget.enabled
        ? this.starterBudget.totalCapLamports - this.starterBudget.grantedLamports
        : 0n,
    };
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

  seedLink(
    userId: number,
    pubkey: string,
    lastGroupId: number | null = null,
    verified = true,
  ): void {
    this.walletHistory.set(pubkey, userId);
    this.links.set(userId, {
      user_id: userId,
      pubkey,
      last_wager_group_id: lastGroupId,
      verified_at: verified ? new Date(0).toISOString() : null,
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

  seedMarketProbability(marketId: string, probability: number): void {
    this.marketProbabilities.set(marketId, probability);
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
      attribution_state: 'orphaned',
      attribution_reason: 'legacy_orphan',
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
    starterGrantsEnabled: false,
    walletMiniappEnabled: false,
    stakeAcceptanceEnabled: false,
    ...overrides,
  };
  return { deps, db, chain, poster, trace };
}
